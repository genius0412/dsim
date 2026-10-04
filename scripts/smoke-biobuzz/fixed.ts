import type { Alliance, ImportedRobot, RobotCommand, RobotSpec, World } from '../../src/types';
import { FLY_FEED_MIN_FRAC, SIM_DT } from '../../src/config';
import { DEFAULT_SPEC } from '../../src/sim/spawn';
import { simModuleFor } from '../../src/games/sim';
import { worldHash } from '../../src/net/checksum';
import { clamp, datan2, hyp, rot, wrapAngle } from '../../src/math';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { startMatch } from '../../src/sim/match';
import { hiveCellTarget } from '../../src/games/biobuzz/elements';
import {
  BB_FIXED_FLY_DEFAULT,
  BB_FIXED_HOOD_DEFAULT_DEG,
  BB_FIXED_HOOD_MAX_DEG,
  BB_FIXED_HOOD_MIN_DEG,
  BB_HALF_Y,
  bbMassLimits,
} from '../../src/games/biobuzz/config';
import { bbCarriesNectar, bbLauncherOf, bbSpansEdge } from '../../src/games/biobuzz/mechs';
import { bbAimTarget, bbFixedBand, bbFixedShotEnters, bbPretendHive } from '../../src/games/biobuzz/play';
import { bbAimHeading, bbFixedRelease, bbFootprint } from '../../src/games/biobuzz/robot';
import { BB_STARTER_BOTS, bbSpecMatches } from '../../src/games/biobuzz/presets';
import { BIOBUZZ_BOT } from '../../src/games/biobuzz/ai';
import { flyExitSpeed } from '../../src/sim/flywheel';
import { type Check, bbCoerce, cmd, setup } from './harness';

/**
 * THE FIXED LAUNCHER LANE (2026-10-02) — `bbMech.launcher.kind === 'fixed'`: the kit robot's
 * one-wheel launcher bolted to an edge at one hood angle, run at a setpoint (`RobotSpec.flywheel`,
 * `src/sim/flywheel.ts`). Nothing about the shot is solved, so the checks are about WHERE it
 * scores from, that the robot (not the launcher) aims, and that every build without one steps
 * exactly as it did.
 */

/** FNV-1a of a string — the exact-bytes digest `smoke.ts`'s standard-robot pins use */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * THE BYTE-IDENTITY PINS, recorded on feat/robot-import 3d9a4120 BEFORE any fixed-shooter code
 * existed (`docs/area/biobuzz.md`, "THE FIXED LAUNCHER"): four robots — the old StarterBot DUMPER
 * build as a literal, a centre turret with a Box Tube, a double turret, a butterfly dumper — all
 * assists on, the fire button on a cadence. Never re-record one to make a fixed-shooter change pass.
 */
const PINS: Record<'2d' | '3d', string> = {
  '2d': 'fired=17 2126857166:3339463799 3482816271:2456356880 1881524541:1265804104',
  '3d': 'fired=11 3143138018:968569403 2080766:4176946555',
};
/** `'3d'` re-recorded 2026-10-04 for `SIM_PATCH` 7: a robot meets a FLOWER's middle and top plates
 *  over their measured outline, not a box. This is the pin it had; a world stepped under patch 6
 *  must still reproduce it. */
const PIN_3D_PATCH6 = 'fired=11 2256851025:431673127 2013511614:1719602821';
/** `'3d'` was re-recorded 2026-10-02 for `SIM_PATCH` 3 — the 3D wall square-up moved into the solve,
 * not a fixed-shooter change. This is the pin it had, and a world stepped under patch 2 (a replay
 * recorded before) must still reproduce it exactly. */
const PIN_3D_PATCH2 = 'fired=14 792568759:3921678035 1757396625:728582646';
const PIN_SPECS: Partial<RobotSpec>[] = [
  { drivetrain: 'tank', driveRpm: 286, length: 15, width: 16, intakeMount: 'front', scoreMode: 'dumper', shooterMount: 'front', ballStorage: 4, bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 75 }, lift: null } },
  { scoreMode: 'turret', intakeMount: 'front', bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'back' }, intake: { kind: 'sweeper' } } },
  { scoreMode: 'twinturret', intakeMount: 'front', drivetrain: 'xdrive', bbMech: { launcher: { kind: 'twinturret', mount: 'right', mount2: 'left', hoodDeg: 75 }, lift: null, intake: { kind: 'sweeper' } } },
  { scoreMode: 'dumper', intakeMount: 'frontback', drivetrain: 'butterfly', bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 75 }, lift: null, intake: { kind: 'siderollers' } } },
];
function pinCmd(w: World, i: number, tick: number): RobotCommand {
  const r = w.robots[i];
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const b of w.balls) {
    if (b.state.kind !== 'ground') continue;
    const d = hyp(b.pos.x - r.pos.x, b.pos.y - r.pos.y);
    if (d < bd) {
      bd = d;
      best = b.pos;
    }
  }
  const full = r.hopper.length >= 3;
  const target = !best || (full && tick % 240 < 120) ? { x: (i % 2 === 0 ? 1 : -1) * 36, y: (i < 2 ? 1 : -1) * 36 } : best;
  const local = rot({ x: target.x - r.pos.x, y: target.y - r.pos.y }, -r.heading);
  const ang = datan2(local.y, local.x);
  const driveY = clamp(local.x / 10, -1, 1);
  const rotate = clamp(-wrapAngle(ang) * 0.9, -1, 1);
  return {
    driveY,
    driveX: clamp(-local.y / 14, -1, 1),
    rotate,
    leftDrive: clamp(driveY - rotate, -1, 1),
    rightDrive: clamp(driveY + rotate, -1, 1),
    intake: tick % 200 < 170,
    fire: r.hopper.length > 0 && tick % 40 < 25,
  };
}
function pinRun(physics: '2d' | '3d', ticks: number, patch?: number): string {
  const mod = simModuleFor('biobuzz');
  const w = mod.createWorld(
    'match',
    9191,
    PIN_SPECS.map((s, i) => ({
      id: i,
      alliance: i % 2 === 0 ? 'blue' : 'red',
      spec: { ...DEFAULT_SPEC, ...s } as RobotSpec,
      assists: { fieldCentric: false, aimAssist: true, autoIntake: true, autoFire: true },
      startIndex: Math.floor(i / 2),
    })),
    undefined,
    physics,
  );
  if (patch !== undefined) w.simPatch = patch;
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 90;
  const out: string[] = [];
  let fired = 0;
  for (let t = 0; t < ticks; t++) {
    const cmds = new Map<number, RobotCommand>();
    for (let i = 0; i < w.robots.length; i++) cmds.set(w.robots[i].id, pinCmd(w, i, t));
    mod.step(w, SIM_DT, cmds);
    for (const r of w.robots) if (r.lastFireAt === w.time) fired++;
    if ((t + 1) % 300 === 0) out.push(`${worldHash(w)}:${fnv(JSON.stringify(patch === undefined ? w : { ...w, simPatch: undefined }))}`);
  }
  return `fired=${fired} ${out.join(' ')}`;
}

/** the kit robot as a BUILD: tank, front sweeper, fixed front launcher at the kit setpoint */
const KIT: Partial<RobotSpec> = {
  drivetrain: 'tank',
  driveRpm: 286,
  length: 15,
  width: 16,
  intakeMount: 'front',
  ballStorage: 4,
  scoreMode: 'dumper',
  shooterMount: 'front',
  bbMech: { launcher: { kind: 'fixed', mount: 'front', hoodDeg: BB_FIXED_HOOD_DEFAULT_DEG }, lift: null, intake: { kind: 'sweeper' } },
  flywheel: { ...BB_FIXED_FLY_DEFAULT, rpm: [...BB_FIXED_FLY_DEFAULT.rpm] },
};
/** the same launcher on a steeper hood (77°, the angle the card used before the CAD was measured):
 *  its band has a far edge on the field, so "long of the band" is a pose a robot can be in */
const STEEP: Partial<RobotSpec> = { ...KIT, bbMech: { ...KIT.bbMech!, launcher: { kind: 'fixed', mount: 'front', hoodDeg: 77 } } };

/** a parked shot: robot 0 on the north cell's mouth axis `d` in out, `yawErr` off facing it, fire
 * held for four seconds. Counts hive ENTRIES (a tip spills a cell, so a final count would lie). */
function parkedShot(physics: '2d' | '3d', spec: Partial<RobotSpec>, d: number, opts: { assist?: boolean; yawErr?: number; ticks?: number; setup?: (w: World) => void } = {}): { scored: number; fired: number; heading: number } {
  const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', spec)], undefined, physics);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 100;
  const r = w.robots[0];
  r.aimAssist = opts.assist ?? true;
  const t = hiveCellTarget('blue', 'north');
  r.pos = { x: t.pos.x, y: t.pos.y + d };
  r.heading = -Math.PI / 2 + (opts.yawErr ?? 0);
  r.turretHeading = r.heading;
  opts.setup?.(w);
  const start = r.hopper.length;
  let scored = 0;
  const cmds = new Map([[0, cmd({ fire: true })]]);
  for (let k = 0; k < (opts.ticks ?? 240); k++) {
    const flying = new Set(w.balls.filter((b) => b.state.kind === 'flight').map((b) => b.id));
    biobuzzStep(w, SIM_DT, cmds);
    for (const b of w.balls) {
      if (flying.has(b.id) && b.state.kind === 'element' && (b.state as { el: string }).el === 'hive:blue') scored++;
    }
  }
  return { scored, fired: start - r.hopper.length, heading: r.heading };
}

/** a held, aimed shot traced tick by tick: robot 0 parked in the middle of its band on the north
 * cell's mouth axis, `yawErr` off the aim heading, aim assist on, fire held, the hopper kept full
 * (a held element cloned per feed). The heading error, the spin and the tick of every feed. */
function aimTrace(physics: '2d' | '3d', spec: Partial<RobotSpec>, yawErr: number, ticks: number): { err: number[]; w: number[]; fires: number[] } {
  const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', spec)], undefined, physics);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 100;
  const r = w.robots[0];
  r.aimAssist = true;
  const band = bbFixedBand(r.spec)!;
  const t = hiveCellTarget('blue', 'north');
  r.pos = { x: t.pos.x, y: t.pos.y + Math.round((band[0] + band[1]) / 2) };
  r.heading = wrapAngle(bbAimHeading(r, bbAimTarget(w, r))! + yawErr);
  r.turretHeading = r.heading;
  const held = w.balls.find((b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id)!;
  const heldState = JSON.stringify(held.state);
  const cap = r.spec.ballStorage ?? 4;
  let id = 100000;
  const out = { err: [] as number[], w: [] as number[], fires: [] as number[] };
  const cmds = new Map([[0, cmd({ fire: true })]]);
  for (let k = 0; k < ticks; k++) {
    while (r.hopper.length < cap) {
      r.hopper.push(held.color);
      w.balls.push({ ...held, id: id++, state: JSON.parse(heldState), pos: { ...r.pos }, vel: { x: 0, y: 0 } });
    }
    biobuzzStep(w, SIM_DT, cmds);
    out.err.push(wrapAngle(bbAimHeading(r, bbAimTarget(w, r))! - r.heading));
    out.w.push(r.angVel);
    if (r.lastFireAt === w.time) out.fires.push(k);
  }
  return out;
}
/** how a heading-error trace settled — `smoke.ts`'s `fxSettle`: the overshoot past zero, how often
 * the error changed side (above a 0.003-rad floor), and the largest error and spin in the last 0.5 s */
function aimSettle(t: { err: number[]; w: number[] }): { over: number; flips: number; endErr: number; endSpin: number } {
  const s0 = Math.sign(t.err[0]);
  let over = 0;
  let flips = 0;
  let side = 0;
  for (const e of t.err) {
    over = Math.max(over, -s0 * e);
    if (Math.abs(e) <= 0.003) continue;
    if (side !== 0 && Math.sign(e) !== side) flips++;
    side = Math.sign(e);
  }
  const tail = (a: number[]): number => Math.max(...a.slice(-30).map(Math.abs));
  return { over: Math.round(over * 1e4) / 1e4, flips, endErr: Math.round(tail(t.err) * 1e4) / 1e4, endSpin: Math.round(tail(t.w) * 1e3) / 1e3 };
}
/** the gaps between feeds, in ticks */
function aimGaps(fires: number[]): number[] {
  return fires.slice(1).map((t, i) => t - fires[i]);
}

export function fixedChecks(check: Check): void {
  const J = (v: unknown): string => JSON.stringify(v);

  // ---- every existing launcher steps byte-identically ------------------------------------------
  {
    const got = pinRun('2d', 900);
    check('fixed: the turret / double turret / dumper builds step byte-identically, 2D (worldHash + whole-world JSON, 900 ticks)', got === PINS['2d'], got);
  }
  {
    const got = pinRun('3d', 600);
    check('fixed: …and in 3D (600 ticks)', got === PINS['3d'], got);
    const old = pinRun('3d', 600, 2);
    check('fixed: …and under SIM_PATCH 2 the 3D run still lands on its pre-patch pin', old === PIN_3D_PATCH2, old);
    const old6 = pinRun('3d', 600, 6);
    check('fixed: …and under SIM_PATCH 6 (square FLOWER plates) the 3D run lands on the pin it had before patch 7', old6 === PIN_3D_PATCH6, old6);
  }

  // ---- the coercer ------------------------------------------------------------------------------
  {
    const kit = bbCoerce(KIT);
    const l = bbLauncherOf(kit, 0);
    check('fixed: a fixed launcher coerces to its own kind on an edge, mirrored as a DUMPER for an older peer', l.kind === 'fixed' && l.mount === 'front' && kit.scoreMode === 'dumper', J({ kind: l.kind, mount: l.mount, scoreMode: kit.scoreMode }));
    check('fixed: …is a fixed point of the coercer', J(bbCoerce(kit)) === J(kit));
    const corner = bbCoerce({ ...KIT, bbMech: { launcher: { kind: 'fixed', mount: 'frontleft', hoodDeg: 10 }, lift: null } });
    const cl = bbLauncherOf(corner, 0);
    check('fixed: a corner mount folds to its edge, and the hood clamps to its own travel', cl.mount === 'front' && cl.hoodDeg === BB_FIXED_HOOD_MIN_DEG, J(cl));
    const high = bbLauncherOf(bbCoerce({ ...KIT, bbMech: { launcher: { kind: 'fixed', mount: 'back', hoodDeg: 99.4 }, lift: null } }), 0);
    check('fixed: …at the top too, in whole degrees', high.hoodDeg === BB_FIXED_HOOD_MAX_DEG, J(high));
    const noFly = bbCoerce({ ...KIT, flywheel: undefined });
    check('fixed: a fixed launcher with no flywheel gets the kit setpoint', J(noFly.flywheel) === J(BB_FIXED_FLY_DEFAULT), J(noFly.flywheel));
    const turret = bbCoerce({ ...KIT, scoreMode: 'turret', bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: null } });
    check('fixed: a turret (or a dumper) drops a stale flywheel, and DECODE’s launcher fields are never on a BIOBUZZ spec', turret.flywheel === undefined && turret.launcher === undefined && turret.hoodDeg === undefined, J({ fly: turret.flywheel, l: turret.launcher, h: turret.hoodDeg }));
    const dumperHood = bbLauncherOf(bbCoerce({ ...KIT, scoreMode: 'dumper', bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 40 }, lift: null } }), 0);
    check('fixed: the dumper keeps its own (unread) 70–85 clamp, untouched', dumperHood.hoodDeg === 70, J(dumperHood));
    const hostile = bbCoerce({ ...KIT, flywheel: { mode: 'presets', rpm: [NaN, 9000, -5, 'x', 1200, 1300, 1400], wheelMm: 1e9, feedS: -1 } });
    check(
      'fixed: a hostile flywheel is clamped field by field (rpm into 500..6000, wheel and feed into range), and its presets fold to the first',
      J(hostile.flywheel) === J({ mode: 'fixed', rpm: [6000], wheelMm: 140, feedS: 0.05 }),
      J(hostile.flywheel),
    );
    check('fixed: …and the clamped one is a fixed point', J(bbCoerce(hostile)) === J(hostile));
    check('fixed: a fixed launcher carries no NECTAR (one small wheel)', !bbCarriesNectar(l));
    check('fixed: it is ONE head on its edge, not a line across the side', !bbSpansEdge('fixed') && bbSpansEdge('dumper'));
    const tubeAtCorner = bbCoerce({ ...KIT, bbMech: { launcher: KIT.bbMech!.launcher, lift: { kind: 'vslide', mount: 'frontleft' } } });
    check('fixed: …so a Box Tube may sit on the corner beside it', tubeAtCorner.bbMech?.lift?.mount === 'frontleft', J(tubeAtCorner.bbMech?.lift));
    check('fixed: the mass floor prices it (tank 13 + sweeper 1.5 + fixed 3.5 = 18)', bbMassLimits(kit).min === 18, String(bbMassLimits(kit).min));
  }

  // ---- the StarterBot card ----------------------------------------------------------------------
  {
    const card = BB_STARTER_BOTS[0];
    const l = bbLauncherOf(card, 0);
    check('StarterBot: a FIXED launcher at the BACK (the end opposite its front sweeper), at the CAD’s 68°, not a dumper',
      l.kind === 'fixed' && l.mount === 'back' && l.hoodDeg === 68 && BB_FIXED_HOOD_DEFAULT_DEG === 68 && card.intakeMount === 'front', J(l));
    const cardBand = bbFixedBand(card);
    check('StarterBot: it scores facing away, from a band that reaches the wall behind it (its autonomous shoots from against a wall)',
      !!cardBand && cardBand[1] - cardBand[0] >= 4 && hiveCellTarget('blue', 'north').pos.y + cardBand[1] + 1 + bbFootprint(card).front > BB_HALF_Y, J(cardBand));
    check(
      'StarterBot: the kit setpoint, 1250 ticks/s at 28 PPR = 2679 rpm, on one 96-mm wheel',
      card.flywheel?.mode === 'fixed' && card.flywheel.rpm[0] === Math.round((1250 / 28) * 60) && card.flywheel.wheelMm === 96,
      J(card.flywheel),
    );
    check('StarterBot: the kit OpMode’s feed minimum (1200/1250) is within half a percent of the shared one', Math.abs(1200 / 1250 - FLY_FEED_MIN_FRAC) < 0.005, `${1200 / 1250} vs ${FLY_FEED_MIN_FRAC}`);
    check('StarterBot: tank, 286 drive rpm (312 rpm on 96 mm), hopper 4, on its mass floor', card.drivetrain === 'tank' && card.driveRpm === 286 && card.ballStorage === 4 && card.massLb === bbMassLimits(card).min, J({ dt: card.drivetrain, rpm: card.driveRpm, s: card.ballStorage, m: card.massLb }));
    check('StarterBot: the card is a fixed point and reads as selected', J(bbCoerce(card)) === J(card) && bbSpecMatches(card, card));
    const asDumper = bbCoerce({ ...card, bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 75 }, lift: null } });
    check('StarterBot: …and a dumper on the same chassis does not match it (the mirror alone cannot tell them apart)', !bbSpecMatches(asDumper, card));
  }

  // ---- where it scores from ---------------------------------------------------------------------
  const kit = bbCoerce(KIT);
  const kitBand = bbFixedBand(kit);
  const band = bbFixedBand(bbCoerce(STEEP));
  check(
    'fixed: the kit launcher (68°) scores from a band that starts on the field and runs to the wall (robot centre to cell centre, on the mouth axis)',
    kitBand !== null && kitBand[1] - kitBand[0] >= 4 && kitBand[1] + 1 + hiveCellTarget('blue', 'north').pos.y + bbFootprint(kit).rear > BB_HALF_Y,
    J(kitBand),
  );
  check(
    'fixed: on a steeper hood (77°) the band has both edges on the field, nearer the cell',
    band !== null && band[1] - band[0] >= 10 && band[1] + 4 + hiveCellTarget('blue', 'north').pos.y + 7.5 <= 72 && !!kitBand && band[0] < kitBand[0],
    J({ band, kitBand }),
  );
  if (kitBand) {
    const kmid = Math.round((kitBand[0] + kitBand[1]) / 2);
    const kitIn = parkedShot('2d', KIT, kmid);
    check(`fixed: the kit launcher parked IN its band (${kmid} in), facing the cell, scores every element`, kitIn.fired === 4 && kitIn.scored === 4, J(kitIn));
  }
  if (band) {
    // the band's two edges, on the steeper hood (the kit's far edge is the wall)
    const mid = Math.round((band[0] + band[1]) / 2);
    const inBand = parkedShot('2d', STEEP, mid);
    check(`fixed: parked IN its band (${mid} in), facing the cell, every element scores`, inBand.fired === 4 && inBand.scored === 4, J(inBand));
    const shortAssist = parkedShot('2d', STEEP, band[0] - 8);
    check('fixed: SHORT of the band, aim assist releases nothing (the arc would not land)', shortAssist.fired === 0, J(shortAssist));
    const shortManual = parkedShot('2d', STEEP, band[0] - 8, { assist: false });
    check('fixed: …and with aim assist off the shot leaves and misses', shortManual.fired > 0 && shortManual.scored === 0, J(shortManual));
    const longManual = parkedShot('2d', STEEP, band[1] + 4, { assist: false });
    check('fixed: LONG of the band, the same: it leaves and misses', longManual.fired > 0 && longManual.scored === 0, J(longManual));
    const offManual = parkedShot('2d', STEEP, mid, { assist: false, yawErr: 0.4 });
    check('fixed: in the band but facing 23° off, a manual shot misses — the launcher does not aim', offManual.fired > 0 && offManual.scored === 0, J(offManual));
    const turned = parkedShot('2d', STEEP, mid, { yawErr: 0.6, ticks: 300 });
    check(
      'fixed: with aim assist, holding fire turns the CHASSIS (a tank, through its side drives) onto the cell and then it scores',
      turned.scored >= 3 && Math.abs(wrapAngle(turned.heading + Math.PI / 2)) < 0.1,
      J(turned),
    );
    const in3d = parkedShot('3d', STEEP, mid);
    check('fixed: …and in 3D the same parked shot scores', in3d.scored >= 3, J(in3d));
    // the feeder waits for the wheel
    let firstShot = -1;
    let rpmAtShot = 0;
    {
      const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', STEEP)]);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 100;
      const r = w.robots[0];
      const t = hiveCellTarget('blue', 'north');
      r.pos = { x: t.pos.x, y: t.pos.y + mid };
      r.heading = -Math.PI / 2;
      r.aimAssist = false;
      r.flyRpm = 800;
      for (let k = 0; k < 120 && firstShot < 0; k++) {
        const before = r.flyRpm ?? 0;
        const n = r.hopper.length;
        biobuzzStep(w, SIM_DT, new Map([[0, cmd({ fire: true })]]));
        if (r.hopper.length < n) {
          firstShot = k;
          rpmAtShot = before;
        }
      }
      const min = BB_FIXED_FLY_DEFAULT.rpm[0] * FLY_FEED_MIN_FRAC;
      check('fixed: a wheel below its feed minimum holds the feeder until it spins up, then feeds', firstShot > 5 && rpmAtShot + 100 >= min, J({ firstShot, rpmAtShot, min }));
    }
  }

  // ---- one setpoint in this game, and the setpoint IS the band ------------------------------------
  {
    const PRE: Partial<RobotSpec> = { ...STEEP, flywheel: { mode: 'presets', rpm: [3000, 2679], wheelMm: 96, feedS: 0.3 } };
    const spec = bbCoerce(PRE);
    check('setpoint: BIOBUZZ folds a presets wheel to its first speed (one setpoint, no preset button)', J(spec.flywheel) === J({ mode: 'fixed', rpm: [3000], wheelMm: 96, feedS: 0.3 }), J(spec.flywheel));
    const slow = bbFixedBand(bbCoerce(STEEP));
    const fast = bbFixedBand(spec);
    check('setpoint: a faster wheel moves the band OUT', !!slow && !!fast && fast[0] > slow[0] && fast[1] >= slow[1], J({ slow, fast }));
    const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', PRE)]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 100;
    const r = w.robots[0];
    for (let k = 0; k < 4; k++) biobuzzStep(w, SIM_DT, new Map([[0, cmd({ flyPreset: true })]]));
    check('setpoint: a stray preset press does nothing to a one-speed wheel', r.flyPreset === undefined && r.flyRpm === 3000, J({ p: r.flyPreset, rpm: r.flyRpm }));
  }

  // ---- the drawn path is the fire gate -----------------------------------------------------------
  {
    const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', KIT)]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 100;
    const r = w.robots[0];
    const t = hiveCellTarget('blue', 'north');
    let agree = 0;
    let made = 0;
    for (let d = 20; d <= 90; d += 5) {
      r.pos = { x: t.pos.x, y: t.pos.y + d };
      r.heading = -Math.PI / 2;
      const hive = bbPretendHive(w.biobuzz!.hives.blue, 'north');
      const gate = bbFixedShotEnters(hive, r, SIM_DT);
      const rel = bbFixedRelease(r, flyExitSpeed(r));
      if (gate) made++;
      if (Number.isFinite(rel.vel.x)) agree++;
    }
    check('fixed: the predicate the path and the gate share says yes somewhere and no elsewhere', made > 0 && made < 15 && agree === 15, `${made}/15`);
  }

  // ---- an imported fixed launcher fires from its lip along its facing -----------------------------
  {
    const imp: ImportedRobot = {
      v: 1,
      id: '0123456789abcdef',
      hull: [{ x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }, { x: -8, y: -8 }],
      heightIn: 14,
      mech: { shooter: { x: 2, y: 3, z: 12 }, shooterYawDeg: 90, intakes: [{ edge: 'front', from: -5, to: 5 }] },
    };
    const spec = bbCoerce({ ...KIT, imported: imp });
    check('import: the facing survives the coercer beside its point', spec.imported?.mech?.shooterYawDeg === 90, J(spec.imported?.mech));
    const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', spec)]);
    const r = w.robots[0];
    r.pos = { x: 10, y: -20 };
    r.heading = 0.3;
    const rel = bbFixedRelease(r, 200);
    const lip = rot({ x: 2, y: 3 }, 0.3);
    const dir = datan2(rel.vel.y, rel.vel.x);
    check(
      'import: a fixed launcher releases from the placed lip, at its height, along heading + shooterYawDeg',
      Math.abs(rel.origin.x - (10 + lip.x)) < 1e-9 && Math.abs(rel.origin.y - (-20 + lip.y)) < 1e-9 && rel.z === 12 && Math.abs(wrapAngle(dir - (0.3 + Math.PI / 2))) < 1e-9,
      J({ rel, lip }),
    );
  }

  // ---- the aim settles and the feed runs at its own rate (2026-10-02, "the robot shakes constantly
  // while shooting and its cadence is really slow") -------------------------------------------------
  {
    // THE AIM IS A HEADING TO HOLD: it does not move with the chassis's own spin. MEASURED BEFORE: it
    // led the muzzle's spin velocity too, 0.047 s per rad/s on the card — under the 27.5/s P loop a
    // feedback of −1.29 a tick on its own spin, so the tank never settled (below).
    const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', BB_STARTER_BOTS[0])]);
    const r = w.robots[0];
    const t = hiveCellTarget('blue', 'north');
    r.pos = { x: t.pos.x, y: t.pos.y + 44 };
    r.heading = Math.PI / 2;
    r.angVel = 0;
    const still = bbAimHeading(r, bbAimTarget(w, r))!;
    r.angVel = 3;
    const spinning = bbAimHeading(r, bbAimTarget(w, r))!;
    check('fixed aim: the heading a fixed launcher steers to does not move with the chassis’s own spin', Math.abs(wrapAngle(spinning - still)) < 1e-12, J({ still, spinning }));
  }
  {
    // MEASURED BEFORE on the card, 2D, 10° off: a ±1.27 rad/s, 30-Hz shake, the heading 0.05–0.09 rad
    // either side of the line every tick for as long as fire was held (236 crossings in 4 s). 3D
    // overshot 0.10. A mecanum and a swerve back launcher crossed 2–4 times on the way in.
    const MEC: Partial<RobotSpec> = { ...KIT, drivetrain: 'mecanum', driveRpm: 435, shooterMount: 'back', bbMech: { ...KIT.bbMech!, launcher: { kind: 'fixed', mount: 'back', hoodDeg: BB_FIXED_HOOD_DEFAULT_DEG } } };
    const SWV: Partial<RobotSpec> = { ...MEC, drivetrain: 'swerve', driveRpm: 480 };
    const runs: [string, Partial<RobotSpec>, '2d' | '3d'][] = [
      ['card 2D', BB_STARTER_BOTS[0], '2d'],
      ['card 3D', BB_STARTER_BOTS[0], '3d'],
      ['mecanum back 2D', MEC, '2d'],
      ['swerve back 2D', SWV, '2d'],
      ['mecanum back 3D', MEC, '3d'],
    ];
    const bad: string[] = [];
    const seen: string[] = [];
    for (const [name, spec, physics] of runs) {
      for (const deg of [10, 30]) {
        const s = aimSettle(aimTrace(physics, spec, (deg * Math.PI) / 180, 150));
        const ok = s.over <= 0.01 && s.flips === 0 && s.endErr < 0.02 && s.endSpin < 0.05;
        (ok ? seen : bad).push(`${name} ${deg}°: ${J(s)}`);
      }
    }
    check(
      'fixed aim: a held shot TURNS ONTO the cell and holds — no overshoot (≤ 0.01 rad), never crosses back, ends within 0.02 rad and still; the card in 2D and 3D, mecanum, swerve',
      bad.length === 0,
      bad.length ? bad.join(' | ') : seen.slice(0, 3).join(' | '),
    );
  }
  {
    // the feed is the hardware's: 0.30 s = 18 ticks. MEASURED BEFORE: 18 or 19 (`world.time` a few
    // ulps short of `fireReadyAt`), 3.2 a second over ten shots instead of 3.33.
    const runs: [string, number[]][] = [
      ['card 2D', aimGaps(aimTrace('2d', BB_STARTER_BOTS[0], 0, 200).fires)],
      ['card 3D', aimGaps(aimTrace('3d', BB_STARTER_BOTS[0], 0, 200).fires)],
      ['card 2D, 30° off', aimGaps(aimTrace('2d', BB_STARTER_BOTS[0], 0.52, 200).fires)],
    ];
    check(
      'fixed aim: from in band the feed runs at its own 0.30 s — every gap 18 ticks, once on target',
      runs.every(([, g]) => g.length >= 9 && g.every((x) => x === 18)),
      J(Object.fromEntries(runs)),
    );
  }

  // ---- a bot driving the kit robot turns to aim and scores ---------------------------------------
  {
    const seats = [setup(0, 'blue', BB_STARTER_BOTS[0]), setup(1, 'red', {}, 1)];
    seats[0].assists = { ...seats[0].assists, aimAssist: true };
    const world = createBiobuzzWorld('match', 31, seats, undefined, '2d');
    startMatch(world);
    world.match.phase = 'teleop';
    world.match.phaseTimeLeft = 140;
    const bot = BIOBUZZ_BOT.create(world, 0, 'hard', 31);
    const cmds = new Map<number, RobotCommand>();
    let entries = 0;
    for (let k = 0; k < 60 * 60; k++) {
      cmds.set(0, bot.step(world));
      const flying = new Set(world.balls.filter((b) => b.state.kind === 'flight' && (b.state as { by?: Alliance }).by === 'blue').map((b) => b.id));
      biobuzzStep(world, SIM_DT, cmds);
      for (const b of world.balls) if (flying.has(b.id) && b.state.kind === 'element' && (b.state as { el: string }).el === 'hive:blue') entries++;
    }
    bot.dispose?.();
    check('AI: a HARD bot driving the kit robot (a fixed launcher) stands in its band, turns to aim and scores', entries >= 4, `${entries} entries in 60 s`);
  }
}
