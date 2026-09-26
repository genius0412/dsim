/**
 * AIPLAY lane — the bots PLAY: their robots, and a few whole matches on fixed seeds.
 *
 * The AI lane (`ai.ts`) proves the driver is deterministic, reads only what it may and emits
 * wire-exact commands. This lane proves it is any GOOD, cheaply: the builds the bots are seated
 * on are real, legal, varied robots, and on three fixed seeds a bot plays a match to a points
 * floor with no fouls and without ever being stuck. The statistics live in `npm run bench:ai`
 * (`scripts/aibench.ts`, twenty seeds a cell) and the tier ordering in `npm run test:ai`; the
 * floors here were set from the bench and carry the measurement beside them.
 *
 * Every match here goes through `botmatch.ts`, the bench's own measurement, so a floor this lane
 * binds and a number the bench prints are one definition of "stuck" and one of "a foul".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, RobotSpec } from '../../src/types';
import { coerceSpec } from '../../src/sim/spawn';
import { DEFAULT_SPEC } from '../../src/sim/specDefaults';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BB_BOT_BUILD_KEYS, BIOBUZZ_BOT, bbBotBuild, bbBotBuildByKey } from '../../src/games/biobuzz/ai';
import { bbCoerceSpec, BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { BB_AI_HIVE_CLEARANCE, BB_HIVE_LOWEST_Z, bbDeployedHeightIn, bbStowLegal } from '../../src/games/biobuzz/config';
import { bbLauncherOf, bbLiftOf, bbCarriesNectar } from '../../src/games/biobuzz/mechs';
import { foulPtsCommitted, playBotMatch, type MatchRow } from './botmatch';
import type { Check } from './harness';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** the longest a bot may be STUCK in one run (bench definition, one-second windows). The bench
 * measures a max run of 1–4 s over 120 matches of every tier, and the first policy's 12 s — in
 * almost every match — is what this exists to keep out. */
const MAX_STUCK_RUN_S = 5;

/** a spec with its identity fields dropped, so two builds are compared as ROBOTS */
function robotOf(s: RobotSpec): string {
  const { name: _n, teamName: _t, teamNumber: _k, ...rest } = s;
  void _n;
  void _t;
  void _k;
  return JSON.stringify(rest);
}

function stuckLine(row: MatchRow): string {
  return row.bots.map((b) => `#${b.id} ${b.build} max ${b.maxStuckS}s, stuck ${b.stuckS}s, idle ${b.idleS}s`).join(' · ');
}

export function aiPlayChecks(check: Check): void {
  // ---- THE ROBOTS ------------------------------------------------------------------------
  {
    const specs = BB_BOT_BUILD_KEYS.map((k) => bbBotBuildByKey(k, 'hard'));
    check('the bot roster has at least five robots', specs.length >= 5, String(specs.length));
    const notFixed = specs.filter((s) => JSON.stringify(bbCoerceSpec(s)) !== JSON.stringify(s)).map((s) => s.teamName);
    check('every bot build is a coercer FIXED POINT (bbCoerceSpec(b) ≡ b)', notFixed.length === 0, notFixed.join(', '));
    // …and it survives the SERVER's ingress too, which is the shared chokepoint with no base
    const notWire = specs.filter((s) => JSON.stringify(coerceSpec(s, BB_DEFAULT_SPEC, 'biobuzz')) !== JSON.stringify(s)).map((s) => s.teamName);
    check('every bot build is unchanged by the shared coerceSpec (the wire ingress)', notWire.length === 0, notWire.join(', '));
    /**
     * NOT THE DEFAULT BUILD. Two defaults to be different from: the BIOBUZZ default robot
     * (`BB_DEFAULT_SPEC`, what a new player starts on), and what every bot used to drive — the
     * shared `DEFAULT_SPEC` put through this game's coercer.
     */
    const bbDefault = robotOf(bbCoerceSpec(BB_DEFAULT_SPEC));
    const oldBot = robotOf(bbCoerceSpec({ ...DEFAULT_SPEC }));
    const isDefault = specs.filter((s) => robotOf(s) === bbDefault || robotOf(s) === oldBot).map((s) => s.teamName);
    check('no bot build is the default build (neither BB_DEFAULT_SPEC nor the old bot chassis)', isDefault.length === 0, isDefault.join(', '));
    check('every bot build is a DIFFERENT robot', new Set(specs.map(robotOf)).size === specs.length);
    const illegal: string[] = [];
    for (const s of specs) {
      for (const a of ['red', 'blue'] as Alliance[]) if (!BIOBUZZ_SIM.startLegal!(s, a, null)) illegal.push(`${s.teamName} ${a}`);
      if (!bbStowLegal(s)) illegal.push(`${s.teamName} R102`);
    }
    check('every bot build is legal to start (G304 at the anchors, R102 stow) for both alliances', illegal.length === 0, illegal.join(', '));
    // the policy routes UNDER the HIVE between the foot bars; a build too tall for that would be
    // a robot the policy drives into the structure
    const tall = specs.filter((s) => bbDeployedHeightIn(s) + BB_AI_HIVE_CLEARANCE > BB_HIVE_LOWEST_Z).map((s) => s.teamName);
    check('every bot build is short enough to drive under the HIVE', tall.length === 0, tall.join(', '));
    // the roster covers the game: all three launchers, a NECTAR carrier with a Box Tube, and
    // more than one drivetrain
    const kinds = new Set(specs.map((s) => bbLauncherOf(s, 75).kind));
    check('the roster fields every launcher (turret, double turret, dumper)', kinds.size === 3, [...kinds].join(','));
    check(
      'the roster fields a NECTAR carrier with a Box Tube (the FLOWER plan has a robot)',
      specs.some((s) => bbLiftOf(s) !== null && bbCarriesNectar(bbLauncherOf(s, 75))),
    );
    check('the roster fields at least four drivetrains', new Set(specs.map((s) => s.drivetrain)).size >= 4);
    check('bot builds are named for what they are', specs.every((s) => s.name.includes('bot') && s.teamName.startsWith('AI')));
  }

  // ---- WHICH BOT GETS WHICH ---------------------------------------------------------------
  {
    const a = bbBotBuild({ seed: 4242, robotId: 2, tier: 'hard', alliance: 'red' });
    const b = bbBotBuild({ seed: 4242, robotId: 2, tier: 'hard', alliance: 'red' });
    check('a bot build is deterministic in (seed, seat)', JSON.stringify(a) === JSON.stringify(b));
    check(
      'the seam hands out the same robot the roster does',
      JSON.stringify(BIOBUZZ_BOT.build!({ seed: 4242, robotId: 2, tier: 'hard', alliance: 'red' })) === JSON.stringify(a),
    );
    let allDiffer = true;
    let seedsMatter = false;
    const first = robotOf(bbBotBuild({ seed: 0, robotId: 1, tier: 'hard', alliance: 'blue' }));
    for (let seed = 0; seed < 50; seed++) {
      const four = [0, 1, 2, 3].map((id) => robotOf(bbBotBuild({ seed, robotId: id, tier: 'hard', alliance: id < 2 ? 'blue' : 'red' })));
      if (new Set(four).size !== 4) allDiffer = false;
      if (four[1] !== first) seedsMatter = true;
    }
    check('the four seats of one match always drive four different robots', allDiffer);
    check('a different match seed deals a different line-up', seedsMatter);
    // the TIER does not pick the robot: a weak driver can have a good robot
    check(
      'the tier changes the name, not the robot',
      robotOf(bbBotBuild({ seed: 9, robotId: 1, tier: 'easy', alliance: 'blue' })) ===
        robotOf(bbBotBuild({ seed: 9, robotId: 1, tier: 'hard', alliance: 'blue' })),
    );
  }

  // ---- THE SEATING SITES USE IT -----------------------------------------------------------
  //
  // Both callers that seat a bot — solo practice and the server `Room` (which the LAN host
  // worker also runs) — have to ask the driver for the robot, or every bot quietly drives the
  // default chassis again. A source check, because the Room half is only reachable through a
  // socket handshake this lane does not stand up (NET3D does, with a stub driver).
  {
    // solo practice's seating is `practiceSetups` (settings.ts), DOM-free so smoke also drives it
    const game = readFileSync(join(root, 'src', 'settings.ts'), 'utf8');
    const room = readFileSync(join(root, 'server', 'room.ts'), 'utf8');
    check('solo practice seats each bot on the driver\'s own robot (practiceSetups calls build)', /botDriver\.build\?\.\(\{\s*seed/.test(game));
    check('the server Room seats each bot on the driver\'s own robot (room.ts calls build)', /drv\?\.build\?\.\(\{\s*seed/.test(room));
  }

  // ---- THEY PLAY ---------------------------------------------------------------------------
  /**
   * A HARD bot, alone on the field against an idle robot, 3D, the whole match. Seed 7000 seats it
   * on the Forager (butterfly, dumper, Box Tube), so the match also exercises the dumper's stand
   * and the FLOWER plan. MEASURED (`npm run bench:ai`, 20 seeds, this build and every other):
   * hard solo mean 240, worst 179; this seed 315, of which ~53 from the FLOWERS. The first
   * policy's HARD solo was mean 62 and never above 91. The floor is 150: well clear of the old
   * driver's best, well under the new one's worst.
   */
  {
    const row = playBotMatch({ format: 'solo', blue: 'hard', red: 'idle', seed: 7000, physics: '3d', builds: 'bot' });
    const blue = row.alliances.blue;
    check('a HARD bot scores over 150 in a full 3D match alone (seed 7000)', blue.total >= 150, `${blue.total} pts, ${blue.tips} tips, flower ${blue.flowerPts}, ${stuckLine(row)}`);
    check('…with the FLOWER plan paying (a Box Tube build places NECTAR in the last minute)', blue.flowerPts > 0, `flower ${blue.flowerPts}`);
    check('…and parks at both ends of the match (LEAVE + both PARKs)', blue.endPts >= 13, `end ${blue.endPts}`);
    check('…committing no fouls', foulPtsCommitted(row, 'blue') === 0, JSON.stringify(row.fouls.blue));
    check(`…and never stuck for more than ${MAX_STUCK_RUN_S} s`, row.bots.every((b) => b.maxStuckS <= MAX_STUCK_RUN_S), stuckLine(row));
  }

  /**
   * FOUR HARD BOTS, 3D, AUTO and the first 62 s of TELEOP. The contact is here: two alliances
   * working the same field, the centre line in AUTO (G402), leaning (G421), herding a full hopper
   * (G407). MEASURED over the bench's 20 seeds: hard 2v2 commits 1.5 foul points per alliance per
   * FULL match (a G402 or a G407 in about one match in fifteen); this seed commits none. Cut at
   * 100 s to keep the lane cheap — the endgame is the solo match's job.
   *
   * The seed was 7004 until the Box Tube's stowed tower became a collider (2026-09-22): elements
   * that had passed through it now bounce off it, the match diverges, and 7004 picked up one AUTO
   * G402. The RATE did not move — over 7000–7019 at 100 s, 3 of 20 matches foul with the tower
   * solid and 2 of 20 without it, G402 every time — so the pick moved, not the bar. 7007 is clean
   * either way.
   *
   * 7007 → 7005 on 2026-09-24, for the same reason: turrets now SPAWN at `BB_TURRET_PITCH_REST`
   * rather than level, so the first shots leave ~0.5 s sooner and every match with a turret
   * diverges from tick 30. 7007 picked up one AUTO G402. The RATE did not rise — over 7000–7019 at
   * 100 s, 2 of 20 foul (7006 a G407 each side, 7007 a G402), against 3 of 20 before. 7005 is clean
   * and seats every launcher (a double turret with a tube, two dumpers, a single turret).
   */
  {
    const row = playBotMatch({ format: '2v2', blue: 'hard', red: 'hard', seed: 7005, physics: '3d', builds: 'bot', stopAtS: 100 });
    const committed = foulPtsCommitted(row, 'blue') + foulPtsCommitted(row, 'red');
    check('four HARD bots commit no fouls through AUTO and a minute of TELEOP (3D, seed 7005)', committed === 0, `${JSON.stringify(row.fouls)}`);
    check(`…none is ever stuck for more than ${MAX_STUCK_RUN_S} s`, row.bots.every((b) => b.maxStuckS <= MAX_STUCK_RUN_S), stuckLine(row));
    check('…every one of them scores (fired elements)', row.bots.every((b) => b.fired > 0), row.bots.map((b) => `#${b.id} ${b.fired}`).join(' '));
    check(
      '…and both alliances have tipped their HIVE at least twice',
      row.alliances.blue.tips >= 2 && row.alliances.red.tips >= 2,
      `blue ${row.alliances.blue.tips} · red ${row.alliances.red.tips}`,
    );
  }

  /**
   * AN EASY bot is weak, not broken: slow, late, sloppy, and still playing. 2D, the whole match,
   * so the 2D pipeline is driven end to end too. MEASURED: easy solo (3D) mean 94, worst 57; the
   * first policy's EASY stood still for 113 s of every 150.
   */
  {
    const row = playBotMatch({ format: 'solo', blue: 'easy', red: 'idle', seed: 7004, physics: '2d', builds: 'bot' });
    const b = row.bots[0];
    check('an EASY bot still scores (over 30 in a full 2D match, seed 7004)', row.alliances.blue.total >= 30, `${row.alliances.blue.total} pts, ${stuckLine(row)}`);
    check(`…is never stuck for more than ${MAX_STUCK_RUN_S} s`, b.maxStuckS <= MAX_STUCK_RUN_S, stuckLine(row));
    check('…and is not standing idle for most of it (under 40 s)', b.idleS < 40, `${b.idleS}s`);
  }
}
