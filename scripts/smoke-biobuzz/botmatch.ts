/**
 * ONE BOT MATCH, MEASURED — shared by `scripts/aibench.ts` (the bench: many matches, a report)
 * and the AIPLAY lane (`aiplay.ts`: a few fixed seeds, floors). One definition of "stuck",
 * "idle" and "a foul", so the floors the lane binds and the numbers the bench prints can never
 * be two different measurements.
 *
 * The caller must have awaited `initPhysics()` (and `initPhysics3d()` for a `'3d'` match).
 *
 * ── HOW STUCK AND IDLE ARE MEASURED ─────────────────────────────────────────
 * Observationally, off the world and the recorded command, never off the policy's own memory —
 * a bench that asked the bot whether it was stuck would measure the bot's opinion of itself.
 * The match is cut into one-second windows (AUTO and TELEOP only; the transition is nobody's):
 *   STUCK   the command asked for translation (mean stick over the window > 0.25) and the chassis
 *           moved less than 4 in. Pressed into a wall, wedged on a foot, pinned in a pile.
 *   IDLE    not stuck, moved less than 3 in, turned less than 0.15 rad, the hopper did not change
 *           and nothing was fired: standing still to no effect, including waiting on a shot.
 * `maxStuckS` is the longest RUN of stuck windows.
 */
import type { Physics } from '../../src/games/types';
import type { Alliance, RobotCommand, RobotSpec, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { startMatch } from '../../src/sim/match';
import { DEFAULT_ASSISTS } from '../../src/sim/spawn';
import { DEFAULT_SPEC } from '../../src/sim/specDefaults';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { bbScoreWorld } from '../../src/games/biobuzz/score';
import type { BiobuzzState } from '../../src/games/biobuzz/state';
import { bbBotBuildByKey } from '../../src/games/biobuzz/ai/builds';
import { BB_PRESET_LIST } from '../../src/games/biobuzz/presets';

/** a builder CARD as a bot's robot (`--builds preset:<name>`): the card's build under the bot's name */
function presetBuild(name: string, tier: string): RobotSpec {
  const want = name.toLowerCase();
  const p = BB_PRESET_LIST.find((x) => x.name.toLowerCase() === want);
  if (!p) throw new Error(`no BIOBUZZ preset called ${JSON.stringify(name)} (cards: ${BB_PRESET_LIST.map((x) => x.name).join(', ')})`);
  return { ...p, name: `${tier} bot`, teamName: `AI · ${p.name}`, teamNumber: 0 };
}
import { newSettleClock, settleStep } from '../../src/sim/settle';

export type BotFormat = 'solo' | '2v2' | 'vs';

export interface BotJob {
  format: BotFormat;
  /** blue pair's tier, red pair's tier (`idle` seats a robot and no driver) */
  blue: string;
  red: string;
  seed: number;
  physics: Physics;
  /** `bot` (the driver's own seating), `default` (every bot on the stock default spec), a roster
   * key forcing that one build on every bot, or `preset:<card name>` (a builder card, e.g.
   * `preset:starterbot`) on every bot */
  builds: string;
  /** stop after this many seconds of MATCH (auto + transition + teleop); absent plays it all */
  stopAtS?: number;
}

export interface BotRow {
  id: number;
  alliance: Alliance;
  tier: string;
  build: string;
  stuckS: number;
  maxStuckS: number;
  idleS: number;
  fired: number;
  cycles: number;
  collected: number;
  distIn: number;
}

export interface AllianceRow {
  total: number;
  foulPts: number;
  tips: number;
  tipPts: number;
  cellPts: number;
  flowerPts: number;
  gardenPts: number;
  endPts: number;
}

export interface MatchRow {
  job: BotJob;
  ms: number;
  ticks: number;
  alliances: Record<Alliance, AllianceRow>;
  /** fouls COMMITTED by each alliance, keyed `M:G402` / `m:G426`, counted per event */
  fouls: Record<Alliance, Record<string, number>>;
  warnings: Record<Alliance, number>;
  bots: BotRow[];
  /** TELEOP seconds left when each alliance first had one of its own NECTAR in a FLOWER, or null */
  firstPlaceLeftS: Record<Alliance, number | null>;
}

const MAX_TICKS = 16_000;
const WINDOW = 60; // one second of ticks
const STUCK_STICK = 0.25;
const STUCK_MOVE = 4;
const IDLE_MOVE = 3;
const IDLE_TURN = 0.15;

export function playBotMatch(job: BotJob): MatchRow {
  const drv = BIOBUZZ_SIM.bot!;
  const t0 = Date.now();
  // SEATING: solo is one bot + an idle robot on the other alliance; 2v2/vs is two per alliance.
  const seats: { id: number; alliance: Alliance; startIndex: number; tier: string }[] =
    job.format === 'solo'
      ? [
          { id: 0, alliance: 'blue', startIndex: job.seed % 2, tier: job.blue },
          { id: 1, alliance: 'red', startIndex: (job.seed + 1) % 2, tier: 'idle' },
        ]
      : [
          { id: 0, alliance: 'blue', startIndex: 0, tier: job.blue },
          { id: 1, alliance: 'blue', startIndex: 1, tier: job.blue },
          { id: 2, alliance: 'red', startIndex: 0, tier: job.red },
          { id: 3, alliance: 'red', startIndex: 1, tier: job.red },
        ];
  const specFor = (s: (typeof seats)[number]): RobotSpec => {
    const name = `${s.tier} bot`;
    if (s.tier === 'idle' || job.builds === 'default') return { ...DEFAULT_SPEC, name, teamName: 'AI', teamNumber: 0 };
    // THE SEATING CODE'S OWN CHOICE — the same call `game.ts` and `Room` make, so a measurement
    // is of the robots players meet
    if (job.builds === 'bot' && drv.build) return drv.build({ seed: job.seed, robotId: s.id, tier: s.tier, alliance: s.alliance });
    if (job.builds.startsWith('preset:')) return presetBuild(job.builds.slice('preset:'.length), s.tier);
    return bbBotBuildByKey(job.builds, s.tier);
  };
  const setups = seats.map((s) => ({
    id: s.id,
    alliance: s.alliance,
    spec: specFor(s),
    assists: { ...DEFAULT_ASSISTS },
    startIndex: s.startIndex,
  }));
  const world: World = BIOBUZZ_SIM.createWorld('match', job.seed, setups, undefined, job.physics);
  startMatch(world);
  // seeded `(matchSeed, seat)` with the same mix `game.ts` and `Room` use
  const bots = seats.map((s) =>
    s.tier === 'idle' ? null : drv.create(world, s.id, s.tier, (job.seed ^ ((s.id + 1) * 0x9e3779b1)) >>> 0),
  );

  const fouls: Record<Alliance, Record<string, number>> = { red: {}, blue: {} };
  const warnings: Record<Alliance, number> = { red: 0, blue: 0 };
  const other = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');
  const FOUL_RE = /^(MINOR|MAJOR) FOUL - (RED|BLUE) \+(\d+) \((.*)\)$/;
  const WARN_RE = /^WARNING - (RED|BLUE) \((.*)\)$/;

  interface Acc {
    stick: number;
    fired: boolean;
    x: number;
    y: number;
    h: number;
    hopperChanged: boolean;
    n: number;
  }
  const rows: BotRow[] = seats.map((s) => ({
    id: s.id,
    alliance: s.alliance,
    tier: s.tier,
    build: '',
    stuckS: 0,
    maxStuckS: 0,
    idleS: 0,
    fired: 0,
    cycles: 0,
    collected: 0,
    distIn: 0,
  }));
  for (const row of rows) {
    const r = world.robots.find((x) => x.id === row.id)!;
    const m = r.spec.bbMech;
    row.build = `${r.spec.drivetrain}/${m?.intake?.kind ?? 'sweeper'}@${r.spec.intakeMount}/${m?.launcher.kind}@${m?.launcher.mount}${m?.lift ? '+tube' : ''}`;
  }
  const acc: Acc[] = seats.map(() => ({ stick: 0, fired: false, x: 0, y: 0, h: 0, hopperChanged: false, n: 0 }));
  const runStuck: number[] = seats.map(() => 0);
  const lastPos = world.robots.map((r) => ({ x: r.pos.x, y: r.pos.y }));
  const lastHopper = world.robots.map((r) => r.hopper.length);
  const stopTicks = job.stopAtS !== undefined ? Math.round(job.stopAtS / SIM_DT) : Infinity;

  const cmds = new Map<number, RobotCommand>();
  const settle = newSettleClock();
  const firstPlace: Record<Alliance, number | null> = { red: null, blue: null };
  let ticks = 0;
  let settledOut = false;
  while (ticks < MAX_TICKS && ticks < stopTicks && !settledOut) {
    const live = world.match.phase === 'auto' || world.match.phase === 'teleop';
    seats.forEach((s, i) => {
      const b = bots[i];
      if (!b) return;
      const c = b.step(world);
      cmds.set(s.id, c);
      const r = world.robots[i];
      if (live) {
        const a = acc[i];
        if (a.n === 0) {
          a.x = r.pos.x;
          a.y = r.pos.y;
          a.h = r.heading;
          a.hopperChanged = false;
          a.stick = 0;
          a.fired = false;
        }
        const tank = Math.abs(((c.leftDrive ?? 0) + (c.rightDrive ?? 0)) / 2);
        a.stick += Math.max(Math.hypot(c.driveX, c.driveY), tank);
        if (c.fire || c.bbPlaceNectar) a.fired = true;
      }
    });
    world.events.length = 0;
    BIOBUZZ_SIM.step(world, SIM_DT, cmds);
    ticks++;
    for (const e of world.events) {
      const f = FOUL_RE.exec(e);
      if (f) {
        const offender = other(f[2].toLowerCase() as Alliance);
        const rule = `${f[1] === 'MAJOR' ? 'M' : 'm'}:${f[4].split(' ')[0]}`;
        fouls[offender][rule] = (fouls[offender][rule] ?? 0) + 1;
        continue;
      }
      const w = WARN_RE.exec(e);
      if (w) warnings[w[1].toLowerCase() as Alliance]++;
    }
    world.robots.forEach((r, i) => {
      const row = rows[i];
      const d = Math.hypot(r.pos.x - lastPos[i].x, r.pos.y - lastPos[i].y);
      if (live) row.distIn += d;
      lastPos[i] = { x: r.pos.x, y: r.pos.y };
      const h = r.hopper.length;
      if (live && h !== lastHopper[i]) {
        acc[i].hopperChanged = true;
        if (h > lastHopper[i]) row.collected += h - lastHopper[i];
        else {
          row.fired += lastHopper[i] - h;
          if (h === 0) row.cycles++;
        }
      }
      lastHopper[i] = h;
    });
    if (live) {
      seats.forEach((_s, i) => {
        if (!bots[i]) return;
        const a = acc[i];
        a.n++;
        if (a.n < WINDOW) return;
        const r = world.robots[i];
        const moved = Math.hypot(r.pos.x - a.x, r.pos.y - a.y);
        let turned = Math.abs(r.heading - a.h);
        turned = Math.min(turned, Math.abs(2 * Math.PI - turned));
        const stuck = a.stick / a.n > STUCK_STICK && moved < STUCK_MOVE;
        const row = rows[i];
        if (stuck) {
          row.stuckS++;
          runStuck[i]++;
          row.maxStuckS = Math.max(row.maxStuckS, runStuck[i]);
        } else {
          runStuck[i] = 0;
          if (moved < IDLE_MOVE && turned < IDLE_TURN && !a.hopperChanged && !a.fired) row.idleS++;
        }
        a.n = 0;
      });
    }
    if (world.match.phase === 'teleop' && (firstPlace.red === null || firstPlace.blue === null)) {
      const bb = world.biobuzz as BiobuzzState;
      for (const f of bb.flowers) {
        for (const id of f.stack) {
          const c = world.balls.find((b) => b.id === id)?.color;
          if ((c === 'red' || c === 'blue') && firstPlace[c] === null) firstPlace[c] = world.match.phaseTimeLeft;
        }
      }
    }
    if (world.match.phase === 'post') settledOut = settleStep(settle, world, BIOBUZZ_SIM.settled);
  }
  for (const b of bots) b?.dispose?.();

  const sc = bbScoreWorld(world);
  const al = (a: Alliance): AllianceRow => {
    const s = sc[a];
    return {
      total: world.match.scores[a].total,
      foulPts: world.match.scores[a].foulPoints,
      tips: s.tips,
      tipPts: s.tipPts,
      cellPts: s.cellPts,
      flowerPts: s.ownedPts + s.bottomPts,
      gardenPts: s.gardenPts,
      endPts: s.leave + s.parkAuto + s.parkTele,
    };
  };
  return {
    job,
    ms: Date.now() - t0,
    ticks,
    alliances: { red: al('red'), blue: al('blue') },
    fouls,
    warnings,
    bots: rows.filter((r) => r.tier !== 'idle'),
    firstPlaceLeftS: firstPlace,
  };
}

/** foul POINTS an alliance committed in a match (what it handed the other side) */
export function foulPtsCommitted(row: MatchRow, a: Alliance): number {
  return row.alliances[a === 'red' ? 'blue' : 'red'].foulPts;
}
