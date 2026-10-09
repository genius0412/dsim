import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../../../types';
import type { BotSeat } from '../../types';
import { SIM_DT, TELEOP_DURATION, TRANSITION_DURATION } from '../../../config';
import { clamp, datan2, dcos, dsin, hyp, nextRandom, rot, wrapAngle } from '../../../math';
import { localizeCommand } from '../../../net/protocol';
import { driveParams } from '../../../sim/drivetrain';
import { viewAngleOf } from '../../../sim/field';
import {
  BB_AI_ARRIVE_TOL,
  BB_AI_DECIDE_TICKS,
  BB_AI_GIVEUP_RADIUS,
  BB_AI_GRAB_TOL,
  BB_AI_LZ_GUARD,
  BB_AI_PIN_DECISIONS,
  BB_AI_TARGET_COOLDOWN,
  BB_AI_TURN_GAIN,
  BB_AI_WALL_NEAR,
  BB_FLOWERS,
  BB_FLOWER_UNLOCK_S,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HOOD_DEFAULT_DEG,
  BB_LZ,
  BB_POLLEN_R,
  BB_TIP_POLLEN,
  bbHopperCap,
  BB3_INTAKE_Z,
} from '../config';
import { hiveCellTarget } from '../elements';
import { bbElementRadius, flowerFits, flowerScore, type BbElementKind } from '../flower';
import { hiveLoad, hiveTakingSide, otherSide } from '../hive';
import { bbCarriesNectar, bbIntakeAccepts, bbIsTurreted, bbLauncherOf, bbLiftOf } from '../mechs';
import { EDGE_ANGLE, EDGE_DIR, EDGE_PERP, MOUNT_DIR, bbIntakeEdges, bbIntakeMountOf } from '../mounts';
import { bbAimTarget, bbCellSideOf, bbFixedBand, bbFlightEnters } from '../play';
import {
  bbAimHeading,
  bbFlowerInReach,
  bbMouths,
  bbPlacePointLocal,
  bbTurretRelease,
  bbTurretSolution,
  mouthAxes,
} from '../robot';
import { bbKindIndex, bbParkedNow } from '../score';
import { bbOwnSide } from '../start';
import { biobuzzPhysics, type BbCellSide, type BiobuzzState, type ScoreTarget } from '../state';
import { OBSTACLES, envelopeStand, footprintOf, insideFor, nextWaypoint, poseClear, polarOf, routeLength, type Footprint } from './geom';
import { bbTierSpec, type BbAiTierSpec } from './tiers';
import {
  BB_AI_AUTO_MARGIN,
  BB_AI_CLUSTER_R,
  BB_AI_CONTACT,
  BB_AI_DUMP_FLOOR,
  BB_AI_ESCAPE_LEN,
  BB_AI_LAST_CALL_S,
  BB_AI_NECTAR_FETCH_S,
  BB_AI_PLACE_S,
  BB_AI_TIP_PRIOR_S,
  BB_AI_ROLL_LEAD,
  BB_AI_ROLL_V,
  BB_AI_ROLL_VZ,
  BB_AI_STAND_COOLDOWN,
  BB_AI_STUCK_MOVE,
  BB_AI_STUCK_STICK,
  BB_AI_STUCK_WINDOW,
  BB_AI_WEIGHTS,
  type BbAiWeights,
} from './tuning';

/**
 * BIOBUZZ AI — THE POLICY (Day 3, `docs/biobuzz/plan-3d.md` §6; rewritten 2026-09-22).
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * A deterministic, DOM-free state machine that returns one `RobotCommand` per tick for one
 * seat. It is a DRIVER, not a cheat: it holds the same sticks and buttons a human holds, and
 * everything it does goes through the ordinary pipeline — `bbLaunch` still decides whether its
 * shot goes, `capturePollen` still decides whether its intake takes, `penalties.ts` still bills
 * it.
 *
 * ── WHAT AN EXPERT DOES, AND THEREFORE WHAT THIS DOES ───────────────────────
 * The rewrite was driven by `scripts/aibench.ts` (full matches, every tier, solo and 2v2) and
 * three probes it names in `tuning.ts`. The game is decided by a TIP (20) every eight POLLEN,
 * and everything below is in service of cycle time:
 *   • SHOOT FROM WHERE IT GOES IN. The shared verdict accepts shots the 3D solve then bounces off
 *     the cell's walls; the measured envelope (30–48 in, within 30° of the mouth normal) is 100 %.
 *     The bot walks to the NEAREST point of that envelope, not to a fixed spot.
 *   • A TURRET SHOOTS ON THE MOVE — across the line to the cell or away from it, never closing.
 *   • COUNT TO THE TIP. Fire what the cell needs and keep the rest, never fire into a swing that
 *     will spill it, and walk to the far cell while the tray is still moving.
 *   • NEVER ASK THE FIELD FOR A POSE IT CANNOT HAVE. A corner POLLEN whose mouth-on pose puts the
 *     chassis in two walls is found by `poseClear` and approached another way, or not at all.
 *   • STUCK IS A MEASUREMENT, at any speed: commanded motion and no displacement is an escape and
 *     a written-off target, whether or not the goal is close.
 *   • THE CLOCK: park in the LOADING ZONE at the end of AUTO (LEAVE + PARK, 8 points), and at the
 *     end of the MATCH, leaving when the drive there takes as long as the time left.
 *   • A BOX TUBE BUILD THAT CARRIES NECTAR spends the last minute on the FLOWERS: one NECTAR on a
 *     stack of four POLLEN is 15 points, most of a TIP, for a single element.
 *   • IN A 2v2, leave the partner's elements, take the other side of the envelope, park apart.
 *
 * ── THE READ LIST, AND WHY IT IS SHORT ──────────────────────────────────────
 * Positions and the DERIVED lists, and nothing else:
 *   `world.match.phase` / `.phaseTimeLeft`      the clock every driver can see
 *   `world.robots[*]`  pos, heading, vel, alliance, spec, hopper, turret yaw/pitch
 *   `world.balls[*]`   pos, vel, z, vz, state.kind (+ `by` on a flight), color
 *   `world.biobuzz.spill`  whether a spilled element has touched anything yet (G409)
 *   `world.biobuzz`    `hives[a].up/tipping/released/contents`, `flowers[i].stack`,
 *                      `nectarDue`, `nectarStock`
 * That list is what lets ONE policy drive under BOTH physics — `derive.ts` fills the same fields
 * under the 3D solve that `play.ts` fills under the 2D one.
 *
 * ⚠️ **IT NEVER READS `world.rngState`.** Its randomness is its OWN mulberry32 chain, seeded
 * `(matchSeed, seat)` by the caller. The AI smoke lane proves the absence with a `Proxy`.
 *
 * ⚠️ **NO CLOCK, NO `Math.random`, NO DOM, NO `sim3d/`.** The shared determinism rule plus this
 * game's lazy-chunk boundary. The AI lane greps for all of it.
 *
 * ── HOLD-LAST, QUANTIZED ────────────────────────────────────────────────────
 * The bot RE-DECIDES every `BB_AI_DECIDE_TICKS` and repeats the last command in between (a
 * recorded bot track compresses), staggered by `robotId`. Every command leaves through
 * `localizeCommand`, the wire round-trip, so what is recorded and what is simulated are the
 * same bytes.
 */

type Mode = 'collect' | 'score' | 'park' | 'place' | 'defend' | 'wait';

/** one bot's private memory — the thing that must never be on the `World`. */
interface BbBotMemory {
  /** this seat's weights (`BB_AI_WEIGHTS` unless a harness passed its own) */
  w: BbAiWeights;
  rngState: number;
  /** a per-seat salt for the stable choice noise (`noiseOf`) */
  salt: number;
  last: RobotCommand;
  phase: number;
  first: boolean;
  decisions: number;
  mode: Mode;
  /** the mode the bot has decided it WANTS, and how many decisions it has wanted it — the
   * reaction delay (`BbAiTierSpec.react`) */
  want: Mode;
  wantFor: number;
  target: number | null;
  /** the target the bot is about to switch to, while its reaction delay runs */
  nextTarget: number | null;
  nextTargetFor: number;
  giveUp: Map<number, number>;
  noProgress: number;
  lastHopper: number;
  /** recent positions, for the stuck test: one per decision, `asked` = the command it was
   * holding asked for real motion */
  hist: { x: number; y: number; h: number; asked: boolean; turn: boolean }[];
  escape: number;
  escapeDir: Vec2;
  escapeTurn: number;
  /** the alliance side (±1) an AUTO escape must not cross toward, 0 outside AUTO */
  escapeSide: number;
  leaning: number;
  /** firing stands the bot got stuck reaching, and until when they are avoided */
  badStands: { x: number; y: number; until: number }[];
  /** the flower the bot is placing into */
  flower: number | null;
  /** toggles each decision a press button is wanted, so an EDGE-triggered button (the NECTAR
   * entry, the FLOWER place) gets its rising edge every other decision */
  pressN: boolean;
  /** decisions a dumper has held its trigger inside the envelope without the dump going */
  aimWait: number;
  /** decisions without moving, turning, collecting or firing, and the hopper it is measured against */
  stall: number;
  stallHopper: number;
  /** decisions a full hopper has had loose elements against the footprint (the G407 clock) */
  herd: number;
  /** a tank's staging point on the line into its goal (`route`) */
  stage: Vec2 | null;
  /** the element whose approach line is remembered, and the mouth direction on it */
  apId: number | null;
  apPhi: number;
  pressP: boolean;
  /** the alliance TIPs this bot has watched start (`tipRate`), the swing it saw last decision, and
   * the tick of its first live decision */
  tipsSeen: number;
  wasTipping: boolean;
  startTick: number;
  /** the last decision's summary, for `peek` (bench/trace only) */
  note: string;
}

/** a full zero command, already quantized */
const ZERO: RobotCommand = localizeCommand({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
});

interface BbAiButtons {
  intake: boolean;
  fire: boolean;
  place: boolean;
  placeNectar: boolean;
  nectar: boolean;
}

const NO_BUTTONS: BbAiButtons = { intake: false, fire: false, place: false, placeNectar: false, nectar: false };

/** SEAT A BOT. `seed` is the caller's `(matchSeed, seat)` — see `BotDriver.create`. */
export function createBiobuzzBot(
  world: World,
  robotId: number,
  tier: string,
  seed: number,
  weights?: Partial<BbAiWeights>,
): BotSeat & { peek(): string } {
  void world;
  const t = bbTierSpec(tier);
  const mem: BbBotMemory = {
    w: weights ? { ...BB_AI_WEIGHTS, ...weights } : BB_AI_WEIGHTS,
    // MIX THE SEAT INTO THE SEED, so two seats handed one match seed do not dither in lockstep.
    rngState: (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(robotId + 1, 0x85ebca6b)) | 0,
    salt: (Math.imul(seed | 0, 0x27d4eb2f) ^ Math.imul(robotId + 7, 0x165667b1)) >>> 0,
    last: ZERO,
    phase: ((robotId % BB_AI_DECIDE_TICKS) + BB_AI_DECIDE_TICKS) % BB_AI_DECIDE_TICKS,
    first: true,
    decisions: 0,
    mode: 'collect',
    want: 'collect',
    wantFor: 0,
    target: null,
    nextTarget: null,
    nextTargetFor: 0,
    giveUp: new Map(),
    noProgress: 0,
    lastHopper: 0,
    hist: [],
    escape: 0,
    escapeDir: { x: 0, y: 0 },
    escapeTurn: 1,
    escapeSide: 0,
    leaning: 0,
    badStands: [],
    flower: null,
    pressN: false,
    aimWait: 0,
    stall: 0,
    stallHopper: 0,
    herd: 0,
    stage: null,
    apId: null,
    apPhi: 0,
    pressP: false,
    tipsSeen: 0,
    wasTipping: false,
    startTick: -1,
    note: '',
  };
  return {
    step(w: World): RobotCommand {
      const r = w.robots.find((x) => x.id === robotId);
      if (!r) return ZERO;
      const decide = mem.first || w.tick % BB_AI_DECIDE_TICKS === mem.phase;
      if (decide) {
        mem.first = false;
        mem.last = decideCommand(w, r, t, mem);
      }
      return mem.last;
    },
    peek(): string {
      return mem.note;
    },
  };
}

function roll(mem: BbBotMemory): number {
  const n = nextRandom(mem.rngState);
  mem.rngState = n.state;
  return n.value;
}

/** a STABLE noise value in [0, 1) for (element, epoch): a worse driver's misjudgement of one
 * element's cost, held for a few seconds rather than re-rolled every decision (which would make
 * the bot flip between targets instead of simply picking a worse one). Integer hashing only. */
function noiseOf(mem: BbBotMemory, id: number): number {
  const epoch = Math.floor(mem.decisions / 30);
  let h = (mem.salt ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(epoch + 3, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERCEPTION — everything a decision reads, computed once
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  world: World;
  w: BbAiWeights;
  r: RobotState;
  t: BbAiTierSpec;
  bb: BiobuzzState;
  a: Alliance;
  side: 1 | -1;
  auto: boolean;
  teleop: boolean;
  /** seconds left in the current PHASE, and in the MATCH */
  phaseLeft: number;
  matchLeft: number;
  cap: number;
  fp: Footprint;
  vmax: number;
  accel: number;
  turnRate: number;
  tank: boolean;
  turreted: boolean;
  carriesNectar: boolean;
  lift: boolean;
  kindOf: (id: number) => BbElementKind;
  hive: BiobuzzState['hives'][Alliance];
  /** the cell taking elements right now, and the cell a bot should be lining up on */
  taking: BbCellSide;
  aimSide: BbCellSide;
  aimCell: ScoreTarget;
  /** how many elements from THIS hopper (LIFO order) the aim cell still needs to tip, or
   * Infinity when the hopper cannot tip it */
  needFromHopper: number;
  /** does the load already in the cell plus the flight tip it? */
  tipLoaded: boolean;
  partners: RobotState[];
  opponents: RobotState[];
  dRange: [number, number];
  envAng: number;
  placeWindow: boolean;
  /** the FLOWER plan is live (`hoardingNow`) */
  hoard: boolean;
}

function perceive(world: World, r: RobotState, t: BbAiTierSpec, bb: BiobuzzState, mem: BbBotMemory): Ctx {
  const a = r.alliance;
  const phase = world.match.phase;
  const auto = phase === 'auto';
  const teleop = phase === 'teleop';
  const phaseLeft = phase === 'freeplay' ? Infinity : world.match.phaseTimeLeft;
  const matchLeft = auto ? phaseLeft + TRANSITION_DURATION + TELEOP_DURATION : phaseLeft;
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const turreted = bbIsTurreted(launcher);
  const dp = driveParams(r.spec, r.butterflyTank);
  const fp = footprintOf(r.spec);
  const hive = bb.hives[a];
  const taking = hiveTakingSide(hive);
  const kindOf = bbKindIndex(world);
  let inFlight = 0;
  for (const b of world.balls) {
    if (b.state.kind === 'flight' && b.state.by === a && b.z > 6) inFlight++;
  }
  const load = hiveLoad(hive.contents, kindOf);
  const tipping = hive.tipping > 0;
  const tipLoaded = tipsWith(load.pollen + inFlight, load.nectar);
  const partners = world.robots.filter((o) => o.id !== r.id && o.alliance === a && !o.passive);
  const opponents = world.robots.filter((o) => o.alliance !== a && !o.passive);
  /**
   * THE CELL TO LINE UP ON. While a tray is swinging, the NEXT cell — the robot walks round
   * while the bar moves and fires the moment it releases. And (a tier that counts) when the up
   * cell is about to be tipped by what is already on its way or already standing in its
   * envelope with a partner, the next cell too: two partners both walking to a cell that one of
   * them is about to tip is the most common wasted drive in a 2v2.
   */
  let aimSide: BbCellSide = taking;
  if (t.tipSense) {
    if (tipping && !hive.released) aimSide = otherSide(hive.up);
    else if (!tipping && tipLoaded) aimSide = otherSide(hive.up);
    else if (!tipping) {
      const need = pollenNeeded(load.pollen + inFlight, load.nectar);
      let ready = 0;
      const cell = hiveCellTarget(a, hive.up);
      for (const p of partners) {
        const pol = polarOf(p.pos, cell.pos, cell.mouth ?? { x: 0, y: 1 });
        if (pol.d < 60 && Math.abs(pol.th) < 1.0) ready += p.hopper.length;
      }
      if (ready >= need && need > 0 && need <= 8 && hopperTipCount(r.hopper, load.pollen + inFlight, load.nectar) === Infinity) {
        aimSide = otherSide(hive.up);
      }
    }
  }
  const aimCell = hiveCellTarget(a, aimSide);
  const needFromHopper = aimSide === taking && !tipping ? hopperTipCount(r.hopper, load.pollen + inFlight, load.nectar) : Infinity;
  // a FIXED launcher's band is its arc's, not a habit: it is measured off the fire gate itself
  // (`bbFixedBand`) and held an inch inside at each end, because the robot only stands NEAR a point
  const band = launcher.kind === 'fixed' ? bbFixedBand(r.spec) : null;
  const dBase = turreted
    ? [mem.w.turretD0, mem.w.turretD1]
    : band
      ? [band[0] + 1, Math.max(band[0] + 1, band[1] - 1)]
      : [mem.w.dumpD0, mem.w.dumpD1];
  const carriesNectar = bbCarriesNectar(launcher);
  const lift = bbLiftOf(r.spec) !== null;
  const ctx: Ctx = {
    world,
    w: mem.w,
    r,
    t,
    bb,
    a,
    side: bbOwnSide(a),
    auto,
    teleop,
    phaseLeft,
    matchLeft,
    cap: bbHopperCap(r.spec),
    fp,
    vmax: Math.max(20, dp.maxSpeed * t.speedCap),
    accel: Math.max(60, dp.accel),
    turnRate: Math.max(1, dp.maxTurn),
    tank: dp.saturation === 'tank',
    turreted,
    carriesNectar,
    lift,
    kindOf,
    hive,
    taking,
    aimSide,
    aimCell,
    needFromHopper,
    tipLoaded,
    partners,
    opponents,
    // a DUMPER's far edge is its throw, not a habit: past ~44 in there is no dump solution at all, and
    // the tuned band already reaches 45.5, so a sloppy tier widens it inward only — and not past
    // `BB_AI_DUMP_FLOOR`: from 25 in a dump lands 25–75 % (medium forager −15 a solo match at 25.5)
    dRange: turreted
      ? [dBase[0] - t.envPad * 0.5, dBase[1] + t.envPad]
      : band
        ? [dBase[0], dBase[1]] // a FIXED arc has no sloppy edge to widen: out of band, it misses
        : [Math.min(dBase[0], Math.max(BB_AI_DUMP_FLOOR, dBase[0] - t.envPad * 0.6)), dBase[1]],
    // a FIXED arc is measured on the mouth axis; well off it the cell is crossed at an angle
    envAng: launcher.kind === 'fixed' ? Math.min(t.envAng, 0.35) : t.envAng + (launcher.kind === 'dumper' ? 0.2 : 0),
    placeWindow: teleop && world.match.phaseTimeLeft <= BB_FLOWER_UNLOCK_S,
    hoard: false,
  };
  ctx.hoard = hoardingNow(ctx, world, mem);
  return ctx;
}

/** does a cell holding this load tip? (`hiveWillTip`, spelled over two numbers) */
function tipsWith(pollen: number, nectar: number): boolean {
  return pollen >= BB_TIP_POLLEN[Math.min(nectar, BB_TIP_POLLEN.length - 1)];
}

/** POLLEN still needed to tip a cell holding this load, with no more NECTAR */
function pollenNeeded(pollen: number, nectar: number): number {
  return Math.max(0, BB_TIP_POLLEN[Math.min(nectar, BB_TIP_POLLEN.length - 1)] - pollen);
}

/** how many elements off the TOP of this hopper (LIFO — the order `bbLaunch` fires) tip a cell
 * holding this load, or Infinity when the whole hopper does not */
function hopperTipCount(hopper: readonly string[], pollen: number, nectar: number): number {
  let p = pollen;
  let n = nectar;
  if (tipsWith(p, n)) return 0;
  for (let i = hopper.length - 1, k = 1; i >= 0; i--, k++) {
    if (hopper[i] === 'red' || hopper[i] === 'blue') n++;
    else p++;
    if (tipsWith(p, n)) return k;
  }
  return Infinity;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DECISION
// ─────────────────────────────────────────────────────────────────────────────

function decideCommand(world: World, r: RobotState, t: BbAiTierSpec, mem: BbBotMemory): RobotCommand {
  const bb = world.biobuzz as BiobuzzState | undefined;
  const phase = world.match.phase;
  // DISABLED IS ZERO — the sim zeroes a disabled robot's command anyway, but the RECORDED track
  // should not read as a bot holding full stick through the auto→teleop transition.
  if (!bb || (phase !== 'auto' && phase !== 'teleop' && phase !== 'freeplay')) {
    mem.hist.length = 0;
    mem.escape = 0;
    mem.note = 'off';
    return ZERO;
  }
  mem.decisions++;
  if (mem.startTick < 0) mem.startTick = world.tick;

  // ---- SAFETY FIRST: an escape in progress is never hesitated over -------------------------
  if (mem.escape > 0) {
    mem.escape--;
    recordHist(r, mem, true, false);
    mem.note = `escape ${mem.escape}`;
    return escapeCommand(r, t, mem);
  }

  // ---- HESITATION: the reaction model's random half ----------------------------------------
  if (t.hesitate > 0 && roll(mem) < t.hesitate) {
    recordHist(r, mem, asksMotion(mem.last), asksTurn(mem.last));
    return mem.last;
  }

  const c = perceive(world, r, t, bb, mem);
  const swinging = c.hive.tipping > 0;
  if (swinging && !mem.wasTipping) mem.tipsSeen++;
  mem.wasTipping = swinging;
  recordHist(r, mem, asksMotion(mem.last), asksTurn(mem.last));

  // ---- STUCK: measured at any speed --------------------------------------------------------
  if (isStuck(mem)) {
    startEscape(c, mem);
    // WHATEVER IT WAS GOING FOR IS WHAT IT IS STUCK ON — and the stand, if it was scoring.
    if (mem.mode === 'collect' && mem.target !== null) giveUpOn(world, mem, mem.target);
    if (mem.mode === 'score' || mem.mode === 'wait') {
      mem.badStands.push({ x: r.pos.x, y: r.pos.y, until: mem.decisions + BB_AI_STAND_COOLDOWN });
    }
    mem.note = 'stuck';
    return escapeCommand(r, t, mem);
  }

  /**
   * STALL — the stuck test's other half. A bot that has not moved, turned, collected or fired for
   * two seconds while COLLECTING or SCORING is stuck in its own logic rather than against the
   * field: a goal a drivetrain cannot reach the way it was asked to, a trigger the verdict never
   * honours from where it stands. The measured case was a tank lined up on its aim heading with
   * its stand ninety degrees off its nose, commanding nothing, for sixteen seconds. Whatever it
   * was working on goes on the cooldown list and it plans again.
   */
  if (mem.mode === 'collect' || mem.mode === 'score') {
    const prev = mem.hist.length >= 2 ? mem.hist[mem.hist.length - 2] : null;
    const still =
      prev !== null &&
      hyp(r.pos.x - prev.x, r.pos.y - prev.y) < 0.6 &&
      Math.abs(wrapAngle(r.heading - prev.h)) < 0.03 &&
      r.hopper.length === mem.stallHopper &&
      !mem.last.fire;
    mem.stall = still ? mem.stall + 1 : 0;
    mem.stallHopper = r.hopper.length;
    if (mem.stall >= mem.w.stall) {
      mem.stall = 0;
      if (mem.mode === 'collect' && mem.target !== null) giveUpOn(world, mem, mem.target);
      else mem.badStands.push({ x: r.pos.x, y: r.pos.y, until: mem.decisions + BB_AI_STAND_COOLDOWN });
      startEscape(c, mem);
      mem.note = 'stall';
      return escapeCommand(r, t, mem);
    }
  } else mem.stall = 0;

  /**
   * G407 FROM THE BOT'S SIDE — shed what it is herding. CONTROL of five (a full hopper plus one
   * element on the bumper) past MOMENTARY is a warning the first time and a MAJOR every time
   * after, and six is a MAJOR outright. A full robot that has had loose elements against its
   * footprint for over a second backs off them; three seconds is the rule's own clock, so this
   * is well inside it.
   */
  const herded = r.hopper.length >= c.cap ? herdedBy(c) : null;
  mem.herd = herded ? mem.herd + 1 : 0;
  if (herded && mem.herd >= mem.w.herd) {
    mem.herd = 0;
    const dx = r.pos.x - herded.x;
    const dy = r.pos.y - herded.y;
    const d = Math.max(1e-6, hyp(dx, dy));
    mem.hist.length = 0;
    mem.escape = 3;
    mem.escapeTurn = 0;
    mem.escapeSide = c.auto ? c.side : 0;
    mem.escapeDir = { x: dx / d, y: dy / d };
    if (c.auto && c.side * r.pos.x < c.fp.circ + 16 && mem.escapeDir.x * c.side < 0) mem.escapeDir.x = 0;
    mem.note = 'shed';
    return escapeCommand(r, t, mem);
  }

  // ---- G421 FROM THE BOT'S SIDE: stop leaning on an opponent -------------------------------
  const lean = leaningOn(c);
  mem.leaning = lean ? mem.leaning + 1 : 0;
  if (mem.leaning >= BB_AI_PIN_DECISIONS) {
    mem.leaning = 0;
    startEscape(c, mem, lean ?? undefined);
    if (mem.target !== null) giveUpOn(world, mem, mem.target);
    mem.note = 'unpin';
    return escapeCommand(r, t, mem);
  }

  // ---- THE PLAN ----------------------------------------------------------------------------
  const cands = candidates(c, mem);
  const wanted = chooseMode(c, mem, cands);
  // REACTION DELAY: a lower tier keeps working the old plan for a few decisions after it has
  // decided on a new one. The two end-of-period parks are not exempt — being late to them is
  // exactly the weakness.
  if (wanted !== mem.want) {
    mem.want = wanted;
    mem.wantFor = 0;
  } else mem.wantFor++;
  if (mem.mode !== mem.want && (mem.wantFor >= t.react || mem.decisions === 1)) {
    mem.mode = mem.want;
    if (mem.mode !== 'place') mem.flower = null;
  }

  const buttons: BbAiButtons = { ...NO_BUTTONS, nectar: nectarPress(c, mem) };
  let cmd: RobotCommand;
  switch (mem.mode) {
    case 'park':
      cmd = parkRoute(c, mem, buttons);
      break;
    case 'place':
      cmd = placeRoute(c, mem, buttons, cands);
      break;
    case 'score':
      cmd = scoreRoute(c, mem, buttons);
      break;
    case 'defend':
      cmd = defendRoute(c, mem, buttons);
      break;
    case 'wait':
      cmd = waitRoute(c, mem, buttons);
      break;
    default:
      cmd = collectRoute(c, mem, buttons, cands);
  }
  return cmd;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE CHOICE
// ─────────────────────────────────────────────────────────────────────────────

function chooseMode(c: Ctx, mem: BbBotMemory, cands: Cand[]): Mode {
  const { r, t } = c;
  const hop = r.hopper.length;
  // THE PARKS — the clock every driver can see, and the drive the bot would need
  if (c.auto && t.autoPark && c.phaseLeft <= parkEta(c) + c.w.parkMargin) return 'park';
  if (c.teleop && t.parks && c.phaseLeft <= parkEta(c) + c.w.parkMargin) {
    /**
     * …UNLESS THE HOPPER HOLDS A TIP. A TIP is 20 and PARK is 5, and a swing still moving at the
     * buzzer is scored as the TIP it must become (§10.5 A; `score.ts`), so a bot that can reach
     * its envelope and fire before 0:00 does that and parks with whatever is left of the clock.
     */
    const tipNow = t.tipSense && c.needFromHopper <= hop && c.hive.tipping === 0;
    if (tipNow && standEta(c) + 0.8 < c.phaseLeft) return 'score';
    return 'park';
  }
  // THE FLOWERS — a Box Tube build carrying its own NECTAR, from just before the 1:00 window
  /**
   * THE FLOWER PLAN'S ORDER OF WORK. A double turret fires its NECTAR on the same beat as its
   * POLLEN and a dumper throws the whole hopper, so neither can shoot the POLLEN and keep the
   * NECTAR: a bot that started hoarding with POLLEN aboard sat FULL at the loading zone for twelve
   * seconds, ploughing loose elements into a G407 MAJOR. So, before the window: a hopper with
   * POLLEN in it is emptied into the HIVE like any other (a NECTAR in the cell is two points and
   * lowers the tip), and only then does the bot collect NECTAR and nothing else. In the window:
   * place every NECTAR it holds, then shoot what is left.
   */
  const heldN = r.hopper.filter((x) => x === c.a).length;
  const heldP = hop - heldN;
  if (c.hoard) {
    if (heldN > 0 && c.placeWindow && bestFlower(c) !== null) return 'place';
    if (heldP > 0 && (!c.placeWindow || heldN === 0)) return 'score';
    if (hop < c.cap && cands.length > 0) return 'collect';
    // holding NECTAR with the window not yet open, or waiting on the human player's entries
    if (heldN > 0 || c.bb.nectarStock[c.a] > 0) return 'wait';
  }
  // SCORE: stays until the hopper is empty (hysteresis), because a turret that fired one POLLEN
  // and went back to collecting — the first policy did exactly that, a volley per element —
  // spends every cycle driving to the envelope and back.
  if (hop > 0 && !(c.hoard && c.placeWindow && heldN > 0)) {
    if (mem.mode === 'score') return 'score';
    if (hop >= Math.min(c.cap, t.volleyAt)) return 'score';
    if (t.tipSense && c.needFromHopper <= hop) return 'score';
    if (cands.length === 0) return 'score';
    if (c.matchLeft <= BB_AI_LAST_CALL_S + standEta(c)) return 'score';
  }
  if (hop < c.cap && cands.length > 0) return 'collect';
  if (t.defends && hop === 0 && c.teleop && c.opponents.length > 0) return 'defend';
  return 'wait';
}

/**
 * IS THE FLOWER PLAN LIVE — a RATE decision, not a clock.
 *
 * FLOWER points are PERMANENT and CONTESTABLE: a NECTAR placed early leaves the TIP cycle for the
 * rest of the match (fewer NECTAR in the cells, more POLLEN per TIP) and an opponent's NECTAR
 * placed on top takes the FLOWER over. So the plan is the LAST thing a bot does, started when the
 * time left is about what the tour itself needs, and only when the tour pays more per second than
 * the bot's own TIP rate (`tipRate`). The first version hoarded from 1:12 and measured 26–29
 * points a solo match BELOW never placing at all: 52 FLOWER points for 30 s without a TIP.
 *
 * It still needs a Box Tube build that carries NECTAR, a tier that places, a FLOWER worth a
 * NECTAR, and a NECTAR to be had (in the hopper, on the tiles, or in the human player's hand).
 */
function hoardingNow(c: Omit<Ctx, 'hoard'>, world: World, mem: BbBotMemory): boolean {
  if (!(c.t.places && c.lift && c.carriesNectar && c.teleop)) return false;
  const left = world.match.phaseTimeLeft;
  if (left > BB_FLOWER_UNLOCK_S + 12) return false;
  let held = 0;
  for (const x of c.r.hopper) if (x === c.a) held++;
  let floor = 0;
  for (const b of world.balls) if (b.state.kind === 'ground' && b.color === c.a && b.z <= BB3_INTAKE_Z) floor++;
  const lz = BB_LZ[c.a];
  const lzEta = hyp((lz.x0 + lz.x1) / 2 - c.r.pos.x, (lz.y0 + lz.y1) / 2 - c.r.pos.y) / (c.vmax * 0.8) + 1;
  const inHand = c.placeWindow || left <= BB_FLOWER_UNLOCK_S + lzEta ? c.bb.nectarStock[c.a] : 0;
  const nectar = held + floor + inHand;
  if (nectar === 0) return false;
  const plan = flowerTour(c, Math.min(nectar, BB_FLOWERS.length), held);
  if (plan.value <= 0) return false;
  // once started it runs: the tour was worth it when it began and the NECTAR is already aboard
  if (mem.mode === 'place' || (mem.mode === 'wait' && held > 0)) return true;
  if (left > plan.time + mem.w.tourMargin) return false;
  return plan.value / Math.max(1, plan.time) > tipRate(c, mem);
}

/**
 * THE FLOWER TOUR a bot could still make: nearest-neighbour from where it stands through every
 * FLOWER worth a NECTAR (`flowerValue` ≥ 4), at most `n` of them, with a NECTAR fetch priced in
 * for each one beyond the `held` it already carries. Points, and seconds.
 */
function flowerTour(c: Omit<Ctx, 'hoard'>, n: number, held: number): { value: number; time: number } {
  const left: number[] = [];
  for (let i = 0; i < BB_FLOWERS.length; i++) if (flowerValue(c, i) >= 4) left.push(i);
  let at: Vec2 = c.r.pos;
  let value = 0;
  let time = 0;
  for (let k = 0; k < n && left.length > 0; k++) {
    let bi = 0;
    for (let j = 1; j < left.length; j++) {
      const f = BB_FLOWERS[left[j]];
      const g = BB_FLOWERS[left[bi]];
      if (hyp(f.x - at.x, f.y - at.y) < hyp(g.x - at.x, g.y - at.y)) bi = j;
    }
    const i = left.splice(bi, 1)[0];
    const f = BB_FLOWERS[i];
    time += hyp(f.x - at.x, f.y - at.y) / (c.vmax * 0.7) + BB_AI_PLACE_S + (k >= held ? BB_AI_NECTAR_FETCH_S : 0);
    value += flowerValue(c, i);
    at = f;
  }
  return { value, time };
}

/**
 * THIS BOT'S OWN TIP RATE, points per second, from what it has watched its alliance's HIVE do:
 * a swing starting is a TIP. Shrunk toward a prior of one TIP per `BB_AI_TIP_PRIOR_S` so the
 * first tip of a match does not swing it, and split across the alliance's working robots — a
 * robot that stops tipping costs the alliance its own share, not the partner's.
 */
function tipRate(c: Omit<Ctx, 'hoard'>, mem: BbBotMemory): number {
  const elapsed = Math.max(0, (c.world.tick - mem.startTick) * SIM_DT);
  const share = 1 + c.partners.length;
  return (20 * (mem.tipsSeen + 1)) / (elapsed + BB_AI_TIP_PRIOR_S) / share;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDIDATES — what may be collected, and where from
// ─────────────────────────────────────────────────────────────────────────────

interface Cand {
  ball: Artifact;
  goal: Vec2;
  heading: number;
  /** the direction the mouth faces on the approach — what `mem.apPhi` remembers */
  phi: number;
  cost: number;
}

/**
 * EVERY ELEMENT THIS ROBOT MAY TAKE AND CAN REACH, with the pose that puts its mouth on it and
 * a cost in SECONDS. Sorted cheapest first.
 *
 * Reachability is `approach` finding a pose `poseClear` accepts — a corner element whose only
 * mouth-on pose has the chassis in two walls is not a candidate, which is the whole of the fix
 * for the first policy's twelve-second corner presses.
 */
function candidates(c: Ctx, mem: BbBotMemory): Cand[] {
  const { r, t, world } = c;
  if (r.hopper.length >= c.cap) return [];
  const wantPollen = !c.hoard;
  const wantNectar = c.carriesNectar;
  const auto = c.auto || t.homeOnly;
  const pre: { b: Artifact; d: number; p: Vec2 }[] = [];
  const rolling = biobuzzPhysics(world) === '3d';
  for (const b of world.balls) {
    if (b.z > BB3_INTAKE_Z) continue;
    let p = b.pos;
    if (b.state.kind !== 'ground') {
      /**
       * A ROLLING ELEMENT IS AN ELEMENT. Under the 3D solve a TIP's spill stays `flight` for ~2.8 s
       * after the release (measured over 548 spilled elements: bouncing and rolling on the tiles,
       * mean 50–58 in out from the HIVE, sd ~20), and the intake takes a low flight element in 3D
       * (`bbIntakeAct`'s `lowFlight`). A policy that only read `ground` was blind to the most
       * contested pile on the field for three seconds after every TIP. Low, slow, and already
       * off the tray — one still carrying its spill tag has touched nothing yet, and touching it
       * first is G409 — and aimed where it will be a moment from now.
       */
      if (!rolling || b.state.kind !== 'flight') continue;
      if (Math.abs(b.vz) > BB_AI_ROLL_VZ || hyp(b.vel.x, b.vel.y) > BB_AI_ROLL_V) continue;
      if (c.bb.spill && c.bb.spill[b.id] !== undefined) continue;
      p = insideFor({ x: b.pos.x + b.vel.x * BB_AI_ROLL_LEAD, y: b.pos.y + b.vel.y * BB_AI_ROLL_LEAD }, BB_POLLEN_R);
    }
    const nectar = b.color === 'red' || b.color === 'blue';
    if (nectar ? !wantNectar : !wantPollen) continue;
    if (!bbIntakeAccepts(r.spec, r.alliance, b.color)) continue;
    // a NECTAR lying against a FLOWER is left alone until the 1:00 cue: nudging it into the stack
    // is a G410 MAJOR against this alliance (see the flower zone in `route`)
    if (nectar && !c.placeWindow && BB_FLOWERS.some((f) => hyp(b.pos.x - f.x, b.pos.y - f.y) < 16)) continue;
    if (auto && c.side * b.pos.x < BB_AI_AUTO_MARGIN) continue;
    const until = mem.giveUp.get(b.id);
    if (until !== undefined && mem.decisions < until) continue;
    // an element sitting in THIS alliance's GARDEN scores 1 at the end; leave it there late
    if (c.matchLeft < 12 && inOwnGarden(b, c.a)) continue;
    pre.push({ b, d: hyp(p.x - r.pos.x, p.y - r.pos.y), p });
  }
  if (pre.length === 0) return [];
  pre.sort((x, y) => x.d - y.d || x.b.id - y.b.id);
  const out: Cand[] = [];
  const lastPick = r.hopper.length + 1 >= c.cap || (t.tipSense && c.needFromHopper !== Infinity && r.hopper.length + 1 >= c.needFromHopper);
  const stand = t.lookahead ? standFor(c, mem, c.aimCell) : null;
  for (let i = 0; i < pre.length && out.length < 10; i++) {
    const b = pre[i].b;
    const bp = pre[i].p;
    const ap = approach(c, bp, b.id === mem.apId ? mem.apPhi : undefined);
    if (!ap) continue;
    if (auto && c.side * ap.goal.x < c.fp.circ * 0.75 + BB_AI_AUTO_MARGIN) continue;
    const dist = routeLength(r.pos, ap.goal, c.fp.narrow + 1);
    let cost = dist / c.vmax + Math.abs(wrapAngle(ap.heading - r.heading)) / c.turnRate * c.w.turnW;
    // PLAN THE NEXT LEG: the element picked last before a volley is the one the robot drives to
    // the envelope FROM
    if (stand) cost += (lastPick ? c.w.legLast : c.w.legOther) * (hyp(stand.x - bp.x, stand.y - bp.y) / c.vmax);
    // CLUSTERS: a pile is cheaper per element than a scatter
    let near = 0;
    let tight = 0;
    for (const q of pre) {
      if (q.b.id === b.id) continue;
      const dq = hyp(q.p.x - bp.x, q.p.y - bp.y);
      if (dq < BB_AI_CLUSTER_R) near++;
      if (dq < 8) tight++;
    }
    const room = c.cap - r.hopper.length;
    cost -= Math.min(4, near) * c.w.cluster * Math.min(1, room - 1);
    /**
     * …but NOT a pile the hopper cannot take. Driving into five elements with room for one is
     * CONTROL of six: G407's hold clock LEAKS rather than clearing, so the ones the roller shoved
     * aside stay counted for seconds after they stop touching, and a sweep through a pile measured
     * at six-plus for three seconds with nothing within 25 in of the chassis — a MAJOR.
     */
    if (tight + 1 > room) cost += (tight + 1 - room) * c.w.overRoom;
    // NECTAR is worth more to a build that carries it: three in a cell make a TIP cost three POLLEN
    if (b.color === c.a) cost -= c.hoard ? 2 : c.w.nectar;
    // 2v2: an element the PARTNER is clearly closer to is the partner's
    if (t.coordinates) {
      for (const p of c.partners) {
        if (p.hopper.length >= bbHopperCap(p.spec)) continue;
        const pd = hyp(bp.x - p.pos.x, bp.y - p.pos.y);
        if (pd + 6 < pre[i].d * 0.8) cost += c.w.partner;
      }
    }
    // an opponent sitting on it will get there first, or shove us off it
    for (const o of c.opponents) {
      if (hyp(bp.x - o.pos.x, bp.y - o.pos.y) < 16) cost += c.w.opponent;
    }
    // the misjudgement is of the elements it is NOT already going for: once picked, an element is
    // judged honestly, or a re-rolled estimate turns a worse choice into no choice at all (a tank
    // turning away from an element under its roller for one a field away)
    if (t.choice > 0 && b.id !== mem.target) cost += noiseOf(mem, b.id) * t.choice;
    out.push({ ball: b, goal: ap.goal, heading: ap.heading, phi: ap.phi, cost });
  }
  out.sort((x, y) => x.cost - y.cost || x.ball.id - y.ball.id);
  return out;
}

function inOwnGarden(b: Artifact, a: Alliance): boolean {
  // the GARDEN strip runs along a wall in the alliance's own corner; the element is within a
  // radius of it
  const g = a === 'blue' ? { x0: 47.4, x1: BB_HALF_X, y0: 68.1, y1: BB_HALF_Y } : { x0: -BB_HALF_X, x1: -47.4, y0: -BB_HALF_Y, y1: -68.1 };
  const r = BB_POLLEN_R;
  return b.pos.x > g.x0 - r && b.pos.x < g.x1 + r && b.pos.y > g.y0 - r && b.pos.y < g.y1 + r;
}

/**
 * THE POSE THAT PUTS A MOUTH ON `at`, or null when there is none the field allows.
 *
 * Tried in order of how natural it is: the mounted edge nearest the bearing, the element dead
 * centre in the mouth, the bearing itself — then swung off the bearing, then the element to one
 * side of the mouth, then just inside the roller line (the rollers DRAW an element in from there,
 * `bbIntakeAct`, which is what lets a wall element be taken with the chassis flush). The first
 * pose `poseClear` accepts wins.
 */
function approach(c: Ctx, at: Vec2, prefer?: number): { goal: Vec2; heading: number; phi: number } | null {
  const { r } = c;
  const mouths = bbMouths(r.spec);
  if (mouths.length === 0) return null;
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  // THE LINE IT WAS ALREADY ON wins while it is still clear and still roughly toward the element:
  // an approach re-derived from the bearing every decision swings round the element as the robot
  // moves, and a tank chasing a swinging goal shuttles back and forth over it
  const live = datan2(at.y - r.pos.y, at.x - r.pos.x);
  const bearing = prefer !== undefined && Math.abs(wrapAngle(prefer - live)) < 1.0 ? prefer : live;
  const edges = bbIntakeEdges(bbIntakeMountOf(r.spec));
  // the mounted edge whose required heading is the smallest turn from here first
  const order = [...edges].sort(
    (e1, e2) =>
      Math.abs(wrapAngle(bearing - EDGE_ANGLE[e1] - r.heading)) - Math.abs(wrapAngle(bearing - EDGE_ANGLE[e2] - r.heading)),
  );
  const offsets = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.57, -1.57, 2.2, -2.2, Math.PI];
  for (const edge of order) {
    const m = mouths.find((x) => x.edge === edge);
    if (!m) continue;
    const ax = mouthAxes(m, hl, hw);
    const deep = (ax.uIn + ax.uOut) / 2 + BB_POLLEN_R * 0.3;
    const lip = ax.uOut + BB_POLLEN_R * 0.2;
    const side = Math.max(0, ax.half - BB_POLLEN_R - 0.6);
    for (const off of offsets) {
      const phi = bearing + off;
      const heading = wrapAngle(phi - EDGE_ANGLE[edge]);
      for (const u of [deep, lip]) {
        for (const v of [0, side, -side]) {
          // robot-frame offset of the element from the robot centre
          // `+ ax.vc`: an imported robot's mouth need not be centred on its edge (0 otherwise)
          const lx = EDGE_DIR[edge].x * u + EDGE_PERP[edge].x * (v + ax.vc);
          const ly = EDGE_DIR[edge].y * u + EDGE_PERP[edge].y * (v + ax.vc);
          const off2 = rot({ x: lx, y: ly }, heading);
          const gx = at.x - off2.x;
          const gy = at.y - off2.y;
          if (poseClear(c.fp, gx, gy, heading)) return { goal: { x: gx, y: gy }, heading, phi };
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MODES
// ─────────────────────────────────────────────────────────────────────────────

/** COLLECT — drive the chosen mouth onto the chosen element, intake running. */
function collectRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons, cands: Cand[]): RobotCommand {
  const { r, t } = c;
  const intake = r.hopper.length < c.cap;
  let pick = cands.length > 0 ? cands[0] : null;
  // COMMITMENT: the element the bot is already going for wins unless the new best is clearly
  // cheaper — a greedy rule re-evaluated every decision does not converge
  const held = mem.target !== null ? cands.find((x) => x.ball.id === mem.target) : undefined;
  if (held && pick && held.ball.id !== pick.ball.id) {
    if (pick.cost > held.cost * c.w.switchFrac - 0.2 || pick.cost > held.cost - c.w.switchAbs) pick = held;
  }
  // REACTION DELAY on a target change
  if (pick && held && pick.ball.id !== held.ball.id && t.react > 0) {
    if (mem.nextTarget !== pick.ball.id) {
      mem.nextTarget = pick.ball.id;
      mem.nextTargetFor = 0;
    } else mem.nextTargetFor++;
    if (mem.nextTargetFor < t.react) pick = held;
  }
  trackTarget(c, mem, pick?.ball ?? null);
  if (!pick) {
    mem.note = 'collect:none';
    return waitRoute(c, mem, buttons);
  }
  mem.apId = pick.ball.id;
  mem.apPhi = pick.phi;
  mem.note = `collect #${pick.ball.id} c${pick.cost.toFixed(1)}`;
  return route(c, mem, pick.goal, pick.heading, { ...buttons, intake, fire: turretFire(c) }, BB_AI_GRAB_TOL);
}

/** SCORE — walk to the nearest stand in the firing envelope of the cell to line up on, and fire
 * when the shot goes in. */
function scoreRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons): RobotCommand {
  const { r, t } = c;
  const cell = c.aimCell;
  const stand = standFor(c, mem, cell);
  const intake = r.hopper.length < c.cap;
  const inEnv = inEnvelope(c, r.pos);
  if (c.turreted) {
    const fire = turretFire(c);
    mem.note = `score ${c.aimSide}${fire ? ' FIRE' : ''} need${c.needFromHopper === Infinity ? '-' : c.needFromHopper}`;
    // a TURRET inside the envelope with a shot on stops chasing the exact stand
    if (inEnv && fire) return command(c, { x: 0, y: 0 }, 0, 0, { ...buttons, fire, intake });
    return route(c, mem, stand, null, { ...buttons, fire, intake }, BB_AI_ARRIVE_TOL);
  }
  /**
   * A DUMPER TURNS THE WHOLE ROBOT, so inside the envelope it STOPS and turns: the stand is a
   * means, not the goal. A tank cannot slide the last few inches onto a stand beside it — it
   * sat level with one for sixteen seconds, turned to its aim heading with the stand 90° off its
   * nose — and every stand in the envelope throws as well as its centre.
   *
   * The trigger is HELD from the moment the robot is in the envelope and may fire at all:
   * `bbAimAssist` then owns the chassis heading and `bbLaunch` releases the instant the dump
   * would land, which is exactly the "turn, then throw" a driver does with one button. If that
   * never happens (a dump solution that is short from here) the bot walks on to the stand.
   */
  const want = bbAimHeading(r, cell);
  const may = mayFireAt(c) && !(c.hoard && c.placeWindow && r.hopper.some((x) => x === c.a)) && hyp(r.vel.x, r.vel.y) < 14;
  if (inEnv && may) {
    mem.aimWait++;
    if (mem.aimWait < 14) {
      mem.note = `score ${c.aimSide} DUMP`;
      return command(c, { x: 0, y: 0 }, 0, turnFor(r, want, t), { ...buttons, fire: true, intake });
    }
  } else if (!inEnv) mem.aimWait = 0;
  if (mem.aimWait >= 24) mem.aimWait = 0;
  mem.note = `score ${c.aimSide} walk`;
  // line up from a few feet out so the last inches are a slide, not a spin
  const lineUp = hyp(stand.x - r.pos.x, stand.y - r.pos.y) > 18 ? null : want;
  return route(c, mem, stand, lineUp, { ...buttons, intake }, BB_AI_ARRIVE_TOL);
}

/** PARK — at least partially in the LOADING ZONE, not touching the wall it started on. */
function parkRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons): RobotCommand {
  const { r } = c;
  const spot = parkSpot(c);
  const parked = bbParkedNow(r) && hyp(spot.x - r.pos.x, spot.y - r.pos.y) < 10;
  mem.note = parked ? 'parked' : 'park';
  const fire = c.turreted ? turretFire(c) : false;
  if (parked) return command(c, { x: 0, y: 0 }, 0, 0, { ...buttons, fire });
  return route(c, mem, spot, null, { ...buttons, fire, intake: r.hopper.length < c.cap }, BB_AI_ARRIVE_TOL);
}

/** where this robot parks: just inside the LOADING ZONE's field-side edge, partners apart */
function parkSpot(c: Ctx): Vec2 {
  const z = BB_LZ[c.a];
  const inner = c.a === 'blue' ? z.x0 : z.x1;
  const x = inner + c.side * 1.5;
  const mid = (z.y0 + z.y1) / 2;
  // partners take the two ends of the zone, by id, so they do not park in each other
  let y = mid;
  if (c.partners.length > 0) {
    const lower = c.partners.every((p) => p.id > c.r.id);
    y = mid + (lower ? 1 : -1) * 10 * (c.a === 'blue' ? 1 : -1);
  }
  return insideFor({ x, y }, c.fp.half + 1);
}

function parkEta(c: Ctx): number {
  const spot = parkSpot(c);
  if (bbParkedNow(c.r)) return 0;
  const d = routeLength(c.r.pos, spot, c.fp.narrow + 1);
  return d / (c.vmax * 0.8) + 0.4;
}

/**
 * seconds to the nearest point of the aim cell's envelope, BY ROAD. It used to be the straight line
 * to the cell less the band's far edge, which is right only on the cell's own side: from the far
 * end of the field the envelope is ~100 in round the HIVE, not ~40, and a bot 2.8 s from the buzzer
 * walked off to score one element instead of parking (5 points lost, seed 7000).
 */
function standEta(c: Ctx): number {
  if (inEnvelope(c, c.r.pos)) return 0;
  const cell = c.aimCell;
  const s = insideFor(envelopeStand(c.r.pos, cell.pos, cell.mouth ?? { x: 0, y: 1 }, c.dRange[0], c.dRange[1], c.envAng), c.fp.circ + 1);
  return routeLength(c.r.pos, s, c.fp.narrow + 1) / (c.vmax * 0.8);
}

/**
 * PLACE — put the Box Tube's placement point on a FLOWER ring and press, one NECTAR per FLOWER,
 * best value first. Approached along the flower's own wall normal with the tube's edge facing
 * the wall, so the footprint never meets the wall first.
 */
function placeRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons, cands: Cand[]): RobotCommand {
  const { r, world } = c;
  const lift = bbLiftOf(r.spec);
  const local = bbPlacePointLocal(r.spec);
  if (mem.flower === null || flowerValue(c, mem.flower) < 4) mem.flower = bestFlower(c);
  if (!lift || !local || mem.flower === null) return collectRoute(c, mem, buttons, cands);
  const i = mem.flower;
  const f = BB_FLOWERS[i];
  const inward = f.wall === 'left' ? { x: 1, y: 0 } : f.wall === 'right' ? { x: -1, y: 0 } : f.wall === 'rear' ? { x: 0, y: -1 } : { x: 0, y: 1 };
  const d = MOUNT_DIR[lift.mount];
  // heading that points the tube's mount direction OUT at the wall (−inward)
  const want = wrapAngle(datan2(-inward.y, -inward.x) - datan2(d.y, d.x));
  const off = rot(local, want);
  const goal = { x: f.x - off.x, y: f.y - off.y };
  const inReach = bbFlowerInReach(world, r) === i;
  mem.pressP = !mem.pressP;
  const press = inReach && mem.pressP;
  mem.note = `place F${i + 1}${inReach ? ' REACH' : ''}`;
  if (inReach) return command(c, { x: 0, y: 0 }, 0, turnFor(r, want, c.t), { ...buttons, placeNectar: press });
  // the last few inches straight in along the normal
  const stageDist = hyp(goal.x - r.pos.x, goal.y - r.pos.y);
  const stage = stageDist > 14 ? { x: goal.x + inward.x * 8, y: goal.y + inward.y * 8 } : goal;
  return route(c, mem, stage === goal ? goal : stage, want, buttons, 0.8);
}

/** the value (points to this alliance, net of the opponent's loss) of placing one own NECTAR on
 * top of FLOWER `i`, or 0 when it would not fit or would not change anything */
function flowerValue(c: Pick<Ctx, 'bb' | 'a' | 'kindOf'>, i: number): number {
  const stack = c.bb.flowers[i].stack;
  const me = c.a;
  const kindOf = c.kindOf;
  if (!flowerFits(stack, kindOf, bbElementRadius(me))) return 0;
  const before = flowerScore(stack, kindOf);
  const fake = -1;
  const kind2 = (id: number): BbElementKind => (id === fake ? me : kindOf(id));
  const after = flowerScore([...stack, fake], kind2);
  const mine = (s: typeof before): number =>
    (s.owner === me ? s.ownerPts : 0) + (s.bonusAlliance === me ? s.bonusPts : 0);
  const theirs = (s: typeof before): number =>
    (s.owner !== null && s.owner !== me ? s.ownerPts : 0) + (s.bonusAlliance !== null && s.bonusAlliance !== me ? s.bonusPts : 0);
  return mine(after) - mine(before) + (theirs(before) - theirs(after));
}

function bestFlower(c: Ctx): number | null {
  let best: number | null = null;
  let bestScore = 0;
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const v = flowerValue(c, i);
    if (v < 4) continue;
    const f = BB_FLOWERS[i];
    const mine = hyp(f.x - c.r.pos.x, f.y - c.r.pos.y);
    const eta = mine / c.vmax + 1.5;
    if (eta > c.phaseLeft - 1) continue;
    // a PARTNER carrying its own NECTAR and clearly nearer this FLOWER takes it: two tubes on one
    // stack is a second NECTAR worth two points where the next FLOWER was worth fifteen
    if (c.t.coordinates && c.partners.some((p) => p.hopper.some((x) => x === c.a) && hyp(f.x - p.pos.x, f.y - p.pos.y) + 12 < mine)) continue;
    const s = v / eta;
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

/**
 * DEFEND (HARD only, and only when there is nothing of its own to do) — stand on the OPPONENT's
 * firing stand. A position, not a robot: chasing a chassis ends in contact, and G421 bills
 * PINNING in seconds. Standing where they want to stand costs them the stand without contact.
 */
function defendRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons): RobotCommand {
  const { r, bb } = c;
  const foe: Alliance = c.a === 'red' ? 'blue' : 'red';
  const theirs = hiveCellTarget(foe, hiveTakingSide(bb.hives[foe]));
  const n = theirs.mouth ?? { x: 0, y: 1 };
  let spot = { x: theirs.pos.x + n.x * 40, y: theirs.pos.y + n.y * 40 };
  spot = insideFor(spot, c.fp.circ + 1);
  mem.note = 'defend';
  return route(c, mem, spot, null, { ...buttons, intake: r.hopper.length < c.cap }, 4);
}

/**
 * WAIT — nothing to collect and nothing to fire. NOT a parked robot: it goes to where the next
 * elements will be. A cell that is up now spills OUTBOARD OF ITSELF when it tips, which is the
 * same side as its firing envelope, so the stand of the up cell is where the next pile lands.
 */
function waitRoute(c: Ctx, mem: BbBotMemory, buttons: BbAiButtons): RobotCommand {
  const { r } = c;
  if (c.hoard && r.hopper.some((x) => x === c.a)) {
    // HOLDING NECTAR BEFORE THE WINDOW: wait a couple of feet off the best FLOWER, so the first
    // placement is the moment the cue sounds (the flower zone in `route` keeps it off the foot)
    const i = bestFlower(c);
    if (i !== null) {
      const f = BB_FLOWERS[i];
      const inward = f.wall === 'left' ? { x: 1, y: 0 } : f.wall === 'right' ? { x: -1, y: 0 } : f.wall === 'rear' ? { x: 0, y: -1 } : { x: 0, y: 1 };
      const spot = insideFor({ x: f.x + inward.x * 30, y: f.y + inward.y * 30 }, c.fp.circ + 1);
      mem.note = `wait:F${i + 1}`;
      return route(c, mem, spot, null, { ...buttons, intake: r.hopper.length < c.cap }, 4);
    }
  }
  if (c.hoard) {
    // THE FLOWER PLAN'S WAIT is at the LOADING ZONE, where the human player's NECTAR lands
    const lz = BB_LZ[c.a];
    const spot = insideFor({ x: (lz.x0 + lz.x1) / 2 - c.side * 16, y: (lz.y0 + lz.y1) / 2 }, c.fp.circ + 1);
    mem.note = 'wait:lz';
    return route(c, mem, spot, null, { ...buttons, intake: r.hopper.length < c.cap }, 4);
  }
  const cell = hiveCellTarget(c.a, c.hive.up);
  const stand = standFor(c, mem, cell);
  mem.note = 'wait';
  return route(c, mem, stand, null, { ...buttons, intake: r.hopper.length < c.cap, fire: turretFire(c) }, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENVELOPE AND THE TRIGGER
// ─────────────────────────────────────────────────────────────────────────────

/** is `p` inside this tier's firing envelope of the cell to line up on (or of `cell`)? */
function inEnvelope(c: Ctx, p: Vec2, cell: ScoreTarget = c.aimCell): boolean {
  const pol = polarOf(p, cell.pos, cell.mouth ?? { x: 0, y: 1 });
  return pol.d >= c.dRange[0] && pol.d <= c.dRange[1] && Math.abs(pol.th) <= c.envAng;
}

/**
 * THE STAND — the cheapest point of the envelope to reach, clear of the field, of every robot and
 * of any stand the bot recently got stuck at.
 *
 * Candidates are the nearest point of the envelope (leaning to one side of the mouth in a 2v2,
 * the lower id to one side and its partner to the other) and a grid across the whole envelope,
 * and the cheapest clear one wins on travel time. The first version tried four nearest-point
 * variants and, when a partner stood on all of them, went to the blocked one anyway: the measured
 * 2v2 case was a bot dithering beside its own partner, who was parked on the stand waiting for
 * the tray, until the stuck test threw it off.
 */
function standFor(c: Ctx, mem: BbBotMemory, cell: ScoreTarget): Vec2 {
  const { r } = c;
  const n = cell.mouth ?? { x: 0, y: 1 };
  let bias = 0;
  if (c.t.coordinates && c.partners.length > 0) {
    const lower = c.partners.every((p) => p.id > r.id);
    bias = lower ? -0.8 : 0.8;
  }
  const d0 = c.dRange[0];
  const d1 = c.dRange[1];
  const ang = c.envAng;
  const base = datan2(n.y, n.x);
  const inner = Math.max(0.05, ang - 0.2);
  const cands: { s: Vec2; pref: number }[] = [];
  for (const b of [bias, bias + 0.9, bias - 0.9, 0]) cands.push({ s: envelopeStand(r.pos, cell.pos, n, d0, d1, ang, clamp(b, -1, 1)), pref: b === bias ? 0 : 0.15 });
  for (const f of [-1, -0.5, 0, 0.5, 1]) {
    for (const dd of [d0 + 4, (d0 + d1) / 2, d1 - 4]) {
      const th = base + f * inner;
      // the lean still applies across the grid: the partner's side of the mouth costs a little
      cands.push({ s: { x: cell.pos.x + dcos(th) * dd, y: cell.pos.y + dsin(th) * dd }, pref: 0.2 + (bias !== 0 && f * bias < 0 ? 0.3 : 0) });
    }
  }
  let best: Vec2 | null = null;
  let bestCost = Infinity;
  for (const cand of cands) {
    let s = insideFor(cand.s, c.fp.circ + 1);
    if (c.auto && c.side * s.x < c.fp.circ + BB_AI_AUTO_MARGIN) s = { x: c.side * (c.fp.circ + BB_AI_AUTO_MARGIN), y: s.y };
    if (!inEnvelope(c, s, cell)) continue;
    if (mem.badStands.some((q) => q.until > mem.decisions && hyp(q.x - s.x, q.y - s.y) < 10)) continue;
    if (!poseClear(c.fp, s.x, s.y, r.heading, 0.3)) continue;
    let crowded = false;
    for (const o of c.world.robots) {
      if (o.id === r.id) continue;
      const clear = c.fp.circ + footprintOf(o.spec).circ * 0.8;
      if (hyp(o.pos.x - s.x, o.pos.y - s.y) < clear && hyp(o.vel.x, o.vel.y) < 20) crowded = true;
    }
    if (crowded) continue;
    const cost = hyp(s.x - r.pos.x, s.y - r.pos.y) / c.vmax + cand.pref;
    if (cost < bestCost) {
      bestCost = cost;
      best = s;
    }
  }
  mem.badStands = mem.badStands.filter((q) => q.until > mem.decisions);
  return best ?? insideFor(envelopeStand(r.pos, cell.pos, n, d0, d1, ang, bias), c.fp.circ + 1);
}

/**
 * HOLD A TURRET'S TRIGGER? — the shared verdict, gated by the envelope and the tip count.
 *
 * `bbLaunch` releases only when the verdict agrees, so a `true` here that the verdict refuses
 * costs nothing but a held button; a `false` is the discipline: out of the envelope, closing on
 * the cell, into a tray that is about to swing, into the cell the aim assist is not looking at.
 */
function turretFire(c: Ctx): boolean {
  const { r, t } = c;
  if (!c.turreted || r.hopper.length === 0) return false;
  if (!mayFireAt(c)) return false;
  const cell = c.aimCell;
  if (!inEnvelope(c, r.pos)) return false;
  // CLOSING on the cell flattens the arc and walks the release inside the band
  const toCell = { x: cell.pos.x - r.pos.x, y: cell.pos.y - r.pos.y };
  const d = hyp(toCell.x, toCell.y);
  const closing = d > 1e-6 ? (r.vel.x * toCell.x + r.vel.y * toCell.y) / d : 0;
  if (closing > c.w.maxClosing) return false;
  if (!t.moveFire && hyp(r.vel.x, r.vel.y) > 12) return false;
  // the flower hoard: a double turret fires NECTAR out of its second turret on the same beat,
  // so a bot keeping its NECTAR for the flowers does not hold the trigger with any aboard
  if (c.hoard && c.placeWindow && r.hopper.some((x) => x === c.a)) return false;
  return verdict(c, cell);
}

/**
 * MAY THIS ROBOT FIRE AT ALL RIGHT NOW — the aim assist is looking at the cell that is taking,
 * and (a tier that counts) the cell is not about to swing on what is already on its way.
 */
function mayFireAt(c: Ctx): boolean {
  const { world, r, t, hive } = c;
  const simTarget = bbAimTarget(world, r);
  if (bbCellSideOf(simTarget) !== c.taking) return false;
  if (c.aimSide !== c.taking) return false;
  if (t.tipSense) {
    // a tray that has tipped but not released is still taking — into a cell about to spill
    if (hive.tipping > 0 && !hive.released) return false;
    if (hive.tipping === 0 && c.tipLoaded) return false;
  }
  return true;
}

/** a TURRET's shared verdict, run the way stage 5b runs it (`bbTurretShotEnters` against a
 * pretend hive with the aimed cell up) — a `true` here means `bbLaunch` releases. A DUMPER does
 * not ask: it holds its trigger in the envelope and lets `bbLaunch` decide (`scoreRoute`). */
function verdict(c: Ctx, target: ScoreTarget): boolean {
  const { r, bb, a } = c;
  const pretend: BiobuzzState['hives'][Alliance] = { ...bb.hives[a], up: bbCellSideOf(target), tipping: 0, released: false };
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const exits: readonly (0 | 1)[] = launcher.kind === 'twinturret' ? [0, 1] : [0];
  for (const which of exits) {
    const sol = bbTurretSolution(r, target, which);
    if (!sol || !sol.reachable) continue;
    const rel = bbTurretRelease(r, which, sol.speed);
    if (bbFlightEnters(pretend, a, rel.origin, rel.z, rel.vel, SIM_DT)) return true;
  }
  return false;
}

/**
 * THE HUMAN PLAYER'S BUTTON — spent when this alliance has a robot that can USE a NECTAR (a
 * single turret cannot carry one, so for most builds a NECTAR on the tiles is an obstacle), and
 * pressed by the robot that will collect it, near the zone. EDGE-triggered: pressed every other
 * decision so each press is a fresh rising edge.
 */
function nectarPress(c: Ctx, mem: BbBotMemory): boolean {
  const { t, bb, a, r } = c;
  if (!t.entersNectar || !c.carriesNectar) return false;
  if (bb.nectarStock[a] <= 0) return false;
  const dumping = c.placeWindow;
  if (!(bb.nectarDue[a] > 0 || dumping)) return false;
  // only a robot with room for it, and before the flowers open only a build that shoots NECTAR
  if (r.hopper.length >= c.cap) return false;
  const lz = BB_LZ[a];
  const cx = (lz.x0 + lz.x1) / 2;
  const cy = (lz.y0 + lz.y1) / 2;
  if (hyp(r.pos.x - cx, r.pos.y - cy) > BB_AI_LZ_GUARD * 2) return false;
  mem.pressN = !mem.pressN;
  return mem.pressN;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DRIVE TO `goal` — along the planned route (`nextWaypoint`, round the foot bars), pushed off
 * other robots, braking on a profile the drivetrain can actually stop on, and turning to
 * `wantHeading` on the way. A TANK cannot slide, so it faces the way it is going until the last
 * foot and turns to the task heading there.
 */
function route(
  c: Ctx,
  mem: BbBotMemory,
  goal: Vec2,
  wantHeading: number | null,
  buttons: BbAiButtons,
  arriveTol: number,
): RobotCommand {
  const { r, t } = c;
  let g = c.auto ? ownSide(c, goal) : goal;
  let dx = g.x - r.pos.x;
  let dy = g.y - r.pos.y;
  let dist = hyp(dx, dy);
  if (dist <= arriveTol) return command(c, { x: 0, y: 0 }, 0, turnFor(r, wantHeading, t), buttons);
  /**
   * A TANK ARRIVES ALONG A LINE. It cannot slide onto a pose beside it, and chasing the pose
   * directly from close range is a robot that spins back and forth over the goal (measured: a
   * dozen reversals over one element by a wall). So when the task heading matters and the robot
   * is off the line through the goal along that heading — or past the goal on it — it drives to a
   * STAGING point a foot behind the goal on the line first, and then straight in.
   */
  if (c.tank && wantHeading !== null) {
    const hx = dcos(wantHeading);
    const hy = dsin(wantHeading);
    const along = dx * hx + dy * hy; // how far BEHIND the goal the robot is, along the line (+ = short of it)
    const lateral = Math.abs(-hy * dx + hx * dy);
    const sx = g.x - hx * 14;
    const sy = g.y - hy * 14;
    // a staging point for a DIFFERENT goal is forgotten; one for this goal is held until reached
    // (hysteresis — without it the robot shuttles between the two points along its own axis)
    if (mem.stage && hyp(mem.stage.x - sx, mem.stage.y - sy) > 5) mem.stage = null;
    if (!mem.stage && (along < -2 || lateral > Math.max(5, Math.abs(along) * 0.5))) {
      // a staging point the field pushes more than a few inches is not on the line any more —
      // a goal backed onto a wall is approached by turning in place instead
      const st = insideFor({ x: sx, y: sy }, c.fp.circ + 1);
      if (hyp(st.x - sx, st.y - sy) < 4) mem.stage = st;
    }
    if (mem.stage && hyp(mem.stage.x - r.pos.x, mem.stage.y - r.pos.y) <= 3) mem.stage = null;
    if (mem.stage) {
      g = mem.stage;
      dx = g.x - r.pos.x;
      dy = g.y - r.pos.y;
      dist = hyp(dx, dy);
    }
  } else mem.stage = null;

  const wp = nextWaypoint(r.pos, g, c.fp.narrow + 1);
  const wx = wp.x - r.pos.x;
  const wy = wp.y - r.pos.y;
  const wd = Math.max(1e-6, hyp(wx, wy));
  let dirX = wx / wd;
  let dirY = wy / wd;

  /**
   * THE FLOWERS — kept clear of unless the goal is at one. Before the 1:00 cue a NECTAR that ends
   * up in a FLOWER is a MAJOR against its own alliance (G410) however it got there, and a robot
   * spinning beside a FLOWER foot with a loose NECTAR next to it measured exactly that: a tank
   * turning in place 4 in from F2 knocked its own alliance's NECTAR into the stack 102 s from the
   * end, 20 points to the opponent. The zone is a pure push (no tangent) because a FLOWER sits on
   * a wall and the only way round it is along the wall.
   */
  for (const f of BB_FLOWERS) {
    if (hyp(g.x - f.x, g.y - f.y) < 22) continue;
    const ox = r.pos.x - f.x;
    const oy = r.pos.y - f.y;
    const d = hyp(ox, oy);
    const zone = c.fp.circ + 6;
    if (d >= zone || d < 1e-6) continue;
    const w = clamp((zone - d) / zone, 0, 1);
    dirX += (ox / d) * w * 1.5;
    dirY += (oy / d) * w * 1.5;
  }

  /**
   * A FULL HOPPER DRIVES ROUND LOOSE ELEMENTS. Four aboard and one more against the roller is
   * CONTROL of five (G407), and a sixth ploughed along with it past MOMENTARY is a MAJOR — the
   * last foul the bench still measured once everything else was clean. A soft push off every
   * loose element ahead of the chassis, only while full; with room in the hopper the roller takes
   * what it meets instead.
   */
  if (r.hopper.length >= c.cap) {
    for (const b of c.world.balls) {
      if (b.state.kind !== 'ground' || b.z > BB3_INTAKE_Z) continue;
      const ox = r.pos.x - b.pos.x;
      const oy = r.pos.y - b.pos.y;
      const d = hyp(ox, oy);
      const zone = c.fp.circ + 3;
      if (d >= zone || d < 1e-6) continue;
      if (ox * dirX + oy * dirY > 0) continue; // behind us
      if (hyp(b.pos.x - g.x, b.pos.y - g.y) < 6) continue; // sitting on the goal: nothing to do
      const w = clamp((zone - d) / zone, 0, 1) * 1.1;
      const nx = ox / d;
      const ny = oy / d;
      const sign = -ny * dirX + nx * dirY >= 0 ? 1 : -1;
      dirX += nx * w * 0.5 - ny * sign * w;
      dirY += ny * w * 0.5 + nx * sign * w;
    }
  }

  // OTHER ROBOTS — radial-heavy, tangent-light, scaled to both chassis
  for (const o of c.world.robots) {
    if (o.id === r.id) continue;
    const clear = c.fp.circ * 0.8 + footprintOf(o.spec).circ * 0.8 + c.w.robotClear;
    const ox = r.pos.x - o.pos.x;
    const oy = r.pos.y - o.pos.y;
    const d = hyp(ox, oy);
    if (d >= clear || d < 1e-6) continue;
    // …unless the goal is right next to it (a stand beside a parked partner): then only the
    // part of the push that is not toward the goal
    const w = clamp((clear - d) / clear, 0, 1);
    const nx = ox / d;
    const ny = oy / d;
    const toward = -(nx * dirX + ny * dirY);
    if (toward < -0.2 && d > clear * 0.6) continue; // it is behind us: ignore
    dirX += nx * w * c.w.robotPush;
    dirY += ny * w * c.w.robotPush;
    const sign = -ny * dirX + nx * dirY >= 0 ? 1 : -1;
    dirX += -ny * sign * w * c.w.robotTan;
    dirY += nx * sign * w * c.w.robotTan;
  }
  // IN AUTO nothing — not a robot push, not a tangent — steers toward the centre line near it,
  // and a chassis that has DRIFTED toward it (an x-drive sliding, a shove) is steered back out:
  // G402 bills a corner 2 in over the line in contact with an opponent, and two robots working
  // the space under their own HIVES meet exactly there
  if (c.auto && c.side * r.pos.x < c.fp.circ + 10 && dirX * c.side < 0) dirX = 0;
  if (c.auto) {
    const lim = c.fp.circ * 0.75 + BB_AI_AUTO_MARGIN + 2;
    const inside = c.side * r.pos.x;
    if (inside < lim) dirX += c.side * clamp((lim - inside) / 4, 0, 1.5);
  }
  const n = hyp(dirX, dirY);
  if (n > 1e-6) {
    dirX /= n;
    dirY /= n;
  }

  // SPEED: a braking profile the drivetrain can stop on, with one decision of look-ahead
  const v = hyp(r.vel.x, r.vel.y);
  const stopDist = Math.max(0, dist - arriveTol * 0.5 - v * SIM_DT * BB_AI_DECIDE_TICKS);
  const vWant = Math.min(c.vmax, Math.sqrt(2 * c.accel * c.w.brake * stopDist) + 6);
  let speed = clamp(vWant / Math.max(1, c.vmax / t.speedCap), 0.12, t.speedCap);

  let heading = wantHeading;
  if (c.tank) {
    /**
     * A TANK FACES ITS TRAVEL — forwards or backwards, whichever is the smaller turn from the
     * task heading (or from where it points, with no task heading) — until the goal is dead
     * ahead or dead astern of the task heading, and only then turns to it. A tank cannot slide:
     * holding the task heading with the goal off to one side is a robot commanding nothing.
     */
    let lateral = Infinity;
    if (heading !== null) lateral = Math.abs(-dsin(heading) * dx + dcos(heading) * dy);
    if (heading === null || dist > 14 || lateral > arriveTol + 1) {
      const fwd = datan2(dirY, dirX);
      const back = wrapAngle(fwd + Math.PI);
      const ref = heading ?? r.heading;
      heading = Math.abs(wrapAngle(fwd - ref)) <= Math.abs(wrapAngle(back - ref)) ? fwd : back;
    }
    const err = Math.abs(wrapAngle(heading - r.heading));
    // turn first, then drive: a tank at 60° off its line drives a curve into whatever is beside it
    if (err > 0.6) speed = Math.min(speed, 0.15);
  } else if (heading !== null && dist > BB_AI_ARRIVE_TOL * 4 && nearWall(r.pos)) {
    // WALL SQUARE-UP while travelling: a chassis crossing a perimeter at an angle catches a corner
    heading = Math.round(heading / (Math.PI / 2)) * (Math.PI / 2);
  }
  mem.note += dist > 0 ? ` →(${g.x.toFixed(0)},${g.y.toFixed(0)})` : '';
  return command(c, { x: dirX, y: dirY }, speed, turnFor(r, heading, t), buttons);
}

/** in AUTO a goal is pulled back onto this alliance's own half, with the chassis fully on it */
function ownSide(c: Ctx, p: Vec2): Vec2 {
  const min = c.fp.circ * 0.75 + BB_AI_AUTO_MARGIN;
  if (c.side * p.x >= min) return p;
  return { x: c.side * min, y: p.y };
}

function turnFor(r: RobotState, wantHeading: number | null, t: BbAiTierSpec): number {
  if (wantHeading === null) return 0;
  const err = wrapAngle(wantHeading - r.heading);
  if (Math.abs(err) < t.aimTol) return 0;
  return clamp(err * BB_AI_TURN_GAIN, -1, 1);
}

/**
 * BUILD THE COMMAND — the one place a wanted WORLD direction becomes sticks, and the one place
 * the quantizer runs. The stick frame is the ROBOT's (`r.fieldCentric`, and `viewAngleOf` when
 * it is on), inverted exactly. A TANK steers only from its side drives, so the turn is trimmed
 * out of the forward demand first.
 */
function command(c: Ctx, dir: Vec2, speed: number, turn: number, buttons: BbAiButtons): RobotCommand {
  const { r } = c;
  const dp = driveParams(r.spec, r.butterflyTank);
  const base = {
    intake: buttons.intake,
    fire: buttons.fire,
    bbPlace: buttons.place,
    bbPlaceNectar: buttons.placeNectar,
    bbNectar: buttons.nectar,
  };
  const robotVec = rot({ x: dir.x * speed, y: dir.y * speed }, -r.heading);
  if (dp.saturation === 'tank') {
    const room = 1 - Math.abs(turn);
    const f = clamp(robotVec.x, -room, room);
    return localizeCommand({
      driveX: 0,
      driveY: 0,
      rotate: 0,
      leftDrive: clamp(f - turn, -1, 1),
      rightDrive: clamp(f + turn, -1, 1),
      ...base,
    });
  }
  if (dp.strafeMult === 0) robotVec.y = 0;
  let stick: Vec2;
  if (r.fieldCentric) stick = rot(rot(robotVec, r.heading), viewAngleOf(r.alliance));
  else stick = { x: -robotVec.y, y: robotVec.x };
  return localizeCommand({
    driveX: clamp(stick.x, -1, 1),
    driveY: clamp(stick.y, -1, 1),
    rotate: turn,
    leftDrive: 0,
    rightDrive: 0,
    ...base,
  });
}

function nearWall(p: Vec2): boolean {
  return Math.abs(p.x) > BB_HALF_X - BB_AI_WALL_NEAR || Math.abs(p.y) > BB_HALF_Y - BB_AI_WALL_NEAR;
}

// ─────────────────────────────────────────────────────────────────────────────
// STUCK, ESCAPE, PINS
// ─────────────────────────────────────────────────────────────────────────────

function asksMotion(cmd: RobotCommand): boolean {
  const tank = Math.abs(((cmd.leftDrive ?? 0) + (cmd.rightDrive ?? 0)) / 2);
  return Math.max(hyp(cmd.driveX, cmd.driveY), tank) >= BB_AI_STUCK_STICK;
}

function asksTurn(cmd: RobotCommand): boolean {
  const tank = Math.abs(((cmd.rightDrive ?? 0) - (cmd.leftDrive ?? 0)) / 2);
  return Math.max(Math.abs(cmd.rotate), tank) >= 0.35;
}

function recordHist(r: RobotState, mem: BbBotMemory, asked: boolean, turn: boolean): void {
  mem.hist.push({ x: r.pos.x, y: r.pos.y, h: r.heading, asked, turn });
  if (mem.hist.length > BB_AI_STUCK_WINDOW + 1) mem.hist.shift();
}

/**
 * STUCK — every decision of the window was asking for motion (or for a turn) and the chassis did
 * not move (or turn). Measured at ANY speed: the first policy exempted a robot easing onto its
 * goal, and that exemption is exactly where a robot pressed into a wall a few inches short of an
 * element it can never reach spent twelve seconds.
 */
function isStuck(mem: BbBotMemory): boolean {
  const h = mem.hist;
  if (h.length < BB_AI_STUCK_WINDOW + 1) return false;
  const first = h[0];
  const lastP = h[h.length - 1];
  const moved = hyp(lastP.x - first.x, lastP.y - first.y);
  let allAsked = true;
  let allTurn = true;
  for (let i = 0; i < h.length - 1; i++) {
    if (!h[i].asked) allAsked = false;
    if (!h[i].turn) allTurn = false;
  }
  if (allAsked && moved < BB_AI_STUCK_MOVE) return true;
  if (allTurn && moved < BB_AI_STUCK_MOVE && Math.abs(wrapAngle(lastP.h - first.h)) < 0.08) return true;
  return false;
}

/**
 * START AN ESCAPE — away from whatever the chassis is pressed against: the nearest wall, static
 * or robot, else back the way it was trying to go. Held for `BB_AI_ESCAPE_LEN` decisions.
 */
function startEscape(c: Ctx, mem: BbBotMemory, from?: RobotState): void {
  const { r } = c;
  mem.hist.length = 0;
  mem.escape = BB_AI_ESCAPE_LEN;
  mem.escapeTurn = roll(mem) < 0.5 ? -1 : 1;
  // what the chassis is pressed against, as a push AWAY from it: walls, robots, and the statics
  let ax = 0;
  let ay = 0;
  const reach = c.fp.circ + 3;
  if (from) {
    const dx = r.pos.x - from.pos.x;
    const dy = r.pos.y - from.pos.y;
    const d = Math.max(1e-6, hyp(dx, dy));
    ax += dx / d;
    ay += dy / d;
  }
  if (BB_HALF_X - r.pos.x < reach) ax -= 1;
  if (BB_HALF_X + r.pos.x < reach) ax += 1;
  if (BB_HALF_Y - r.pos.y < reach) ay -= 1;
  if (BB_HALF_Y + r.pos.y < reach) ay += 1;
  for (const b of OBSTACLES) {
    const qx = clamp(r.pos.x, b.x0, b.x1);
    const qy = clamp(r.pos.y, b.y0, b.y1);
    const dx = r.pos.x - qx;
    const dy = r.pos.y - qy;
    const d = hyp(dx, dy);
    if (d < reach && d > 1e-6) {
      ax += dx / d;
      ay += dy / d;
    }
  }
  for (const o of c.world.robots) {
    if (o.id === r.id) continue;
    const dx = r.pos.x - o.pos.x;
    const dy = r.pos.y - o.pos.y;
    const d = hyp(dx, dy);
    if (d < c.fp.circ + footprintOf(o.spec).circ + 2 && d > 1e-6) {
      ax += dx / d;
      ay += dy / d;
    }
  }
  // …and back the way it was trying to go, as a weaker preference
  const l = mem.last;
  const tank = ((l.leftDrive ?? 0) + (l.rightDrive ?? 0)) / 2;
  const sense = Math.abs(tank) > 0.05 ? Math.sign(tank) : 1;
  const bx = -dcos(r.heading) * sense;
  const by = -dsin(r.heading) * sense;
  mem.escapeSide = c.auto ? c.side : 0;
  /**
   * THE CLEAREST WAY OUT — every one of twelve directions (a tank: its two along its own axis) is
   * a candidate, scored by whether the chassis 7 in along it is a pose the field allows
   * (`poseClear`), how far it is from every other robot, and how well it agrees with the push away
   * from whatever is touching. Measured before this: an escape that ignored the HIVE foot bars
   * backed a side-sweeper into the bar it was wedged on, forty-six times in a row, for 56 s.
   *
   * G402 BINDS AN ESCAPE TOO: in AUTO a direction toward the centre line near it scores nothing —
   * the measured case was a wedged tank whose reverse carried it 13 in into the opponent's half
   * and into a blue robot, a MAJOR for a manoeuvre meant to avoid trouble.
   */
  const dirs: Vec2[] = [];
  if (c.tank) {
    dirs.push({ x: dcos(r.heading), y: dsin(r.heading) }, { x: -dcos(r.heading), y: -dsin(r.heading) });
  } else {
    for (let k = 0; k < 12; k++) dirs.push({ x: dcos((k * Math.PI) / 6), y: dsin((k * Math.PI) / 6) });
  }
  const an = hyp(ax, ay);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const d of dirs) {
    const nx = r.pos.x + d.x * 7;
    const ny = r.pos.y + d.y * 7;
    let score = poseClear(c.fp, nx, ny, r.heading, 0.2) ? 10 : 0;
    if (an > 1e-6) score += ((d.x * ax + d.y * ay) / an) * 3;
    score += (d.x * bx + d.y * by) * 1;
    let near = Infinity;
    for (const o of c.world.robots) {
      if (o.id === r.id) continue;
      near = Math.min(near, hyp(o.pos.x - nx, o.pos.y - ny) - footprintOf(o.spec).circ - c.fp.circ);
    }
    if (near < 0) score -= 6;
    if (c.auto && c.side * r.pos.x < c.fp.circ + 16 && d.x * c.side < 0) score -= 30;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = d;
    }
  }
  if (!best || bestScore < 0) {
    // nowhere clear: turn in place, which is what a boxed-in driver does
    mem.escapeDir = { x: 0, y: 0 };
    return;
  }
  mem.escapeDir = { x: best.x, y: best.y };
}

function escapeCommand(r: RobotState, t: BbAiTierSpec, mem: BbBotMemory): RobotCommand {
  const dp = driveParams(r.spec, r.butterflyTank);
  const d = mem.escapeDir;
  const n = hyp(d.x, d.y);
  const dir = n > 1e-6 ? { x: d.x / n, y: d.y / n } : { x: 0, y: 0 };
  const speed = n > 1e-6 ? Math.min(0.7, Math.max(0.45, t.speedCap)) : 0;
  if (dp.saturation === 'tank') {
    // back along the chassis axis in whichever sense points away, and turn
    const along = dir.x * dcos(r.heading) + dir.y * dsin(r.heading);
    let f = speed === 0 ? 0 : clamp(Math.sign(along || -1) * speed, -1, 1);
    // …and in AUTO never along the axis toward the centre line: turn in place instead
    if (mem.escapeSide !== 0 && f * dcos(r.heading) * mem.escapeSide < -0.1 && mem.escapeSide * r.pos.x < 30) f = 0;
    const turn = mem.escapeTurn * 0.4;
    return localizeCommand({ driveX: 0, driveY: 0, rotate: 0, leftDrive: clamp(f - turn, -1, 1), rightDrive: clamp(f + turn, -1, 1), intake: false, fire: false });
  }
  const robotVec = rot({ x: dir.x * speed, y: dir.y * speed }, -r.heading);
  if (dp.strafeMult === 0) robotVec.y = 0;
  const stick = r.fieldCentric ? rot(rot(robotVec, r.heading), viewAngleOf(r.alliance)) : { x: -robotVec.y, y: robotVec.x };
  return localizeCommand({
    driveX: clamp(stick.x, -1, 1),
    driveY: clamp(stick.y, -1, 1),
    rotate: mem.escapeTurn * 0.35,
    leftDrive: 0,
    rightDrive: 0,
    intake: false,
    fire: false,
  });
}

/**
 * THE LOOSE ELEMENTS AGAINST THIS ROBOT'S FOOTPRINT — their centroid, or null when there are
 * none. "Against" is the footprint rect grown by the element's own radius and an inch: a position
 * read of what `bbControlled` counts as herded, which is all this policy is allowed.
 */
function herdedBy(c: Ctx): Vec2 | null {
  const { r } = c;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const ch = dcos(r.heading);
  const sh = dsin(r.heading);
  for (const b of c.world.balls) {
    if (b.state.kind !== 'ground' || b.z > BB3_INTAKE_Z) continue;
    const dx = b.pos.x - r.pos.x;
    const dy = b.pos.y - r.pos.y;
    if (Math.abs(dx) > c.fp.circ + 5 || Math.abs(dy) > c.fp.circ + 5) continue;
    const lx = dx * ch + dy * sh;
    const ly = -dx * sh + dy * ch;
    const pad = (b.r ?? BB_POLLEN_R) + 1;
    if (lx < -c.fp.rear - pad || lx > c.fp.front + pad || Math.abs(ly) > c.fp.half + pad) continue;
    sx += b.pos.x;
    sy += b.pos.y;
    n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

/**
 * the opponent this robot is leaning on — in contact and not moving away from it — or null.
 * Contact is a distance (a position read, which is all this policy may do); the G421 clock the
 * caller keeps against it is `BB_AI_PIN_DECISIONS`, well inside the rule's three seconds.
 */
function leaningOn(c: Ctx): RobotState | null {
  const { r } = c;
  for (const o of c.opponents) {
    const touch = c.fp.circ * 0.85 + footprintOf(o.spec).circ * 0.85 + BB_AI_CONTACT;
    const dx = o.pos.x - r.pos.x;
    const dy = o.pos.y - r.pos.y;
    const d = hyp(dx, dy);
    if (d >= touch || d < 1e-6) continue;
    const away = -(r.vel.x * dx + r.vel.y * dy) / d;
    if (away < 3) return o;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATIENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATIENCE — the bot tries an element for its tier's `patience` in decisions and, if nothing
 * reached the hopper, ignores it (and its neighbours) for `BB_AI_TARGET_COOLDOWN`. Measured
 * against the HOPPER, not the element id: two elements in a corner take turns being the target.
 */
function trackTarget(c: Ctx, mem: BbBotMemory, ball: Artifact | null): void {
  const { r, t, world } = c;
  const id = ball?.id ?? null;
  mem.target = id;
  const grew = r.hopper.length > mem.lastHopper;
  mem.lastHopper = r.hopper.length;
  if (grew || id === null) {
    mem.noProgress = 0;
    return;
  }
  mem.noProgress++;
  if (mem.noProgress < t.patience) return;
  giveUpOn(world, mem, id);
  mem.noProgress = 0;
}

function giveUpOn(world: World, mem: BbBotMemory, id: number): void {
  const until = mem.decisions + BB_AI_TARGET_COOLDOWN;
  const at = world.balls.find((b) => b.id === id);
  mem.giveUp.set(id, until);
  if (at) {
    for (const b of world.balls) {
      if (b.state.kind !== 'ground') continue;
      if (hyp(b.pos.x - at.pos.x, b.pos.y - at.pos.y) <= BB_AI_GIVEUP_RADIUS) mem.giveUp.set(b.id, until);
    }
  }
  mem.target = null;
  // the list is a heuristic: once it holds most of the field it has over-fired
  if (mem.giveUp.size > 24) {
    for (const [k, v] of mem.giveUp) if (v <= mem.decisions) mem.giveUp.delete(k);
  }
}
