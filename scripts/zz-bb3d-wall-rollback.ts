/**
 * PROBE (not a test): how far the BIOBUZZ 3D FULL client's rollback lands from the room near walls,
 * when the client's engine is built from a snapshot the way a real one is (2026-10-02, the online
 * "invisible bump"; `docs/area/biobuzz.md`, the wall square-up).
 *
 * W is the room, stepped from tick 0 by a driver that rams walls, presses into them, slides along
 * and turns on them. C is the client: its engine is built from W's JSON at `join`, it runs `lead`
 * ticks ahead on the same commands, saves its engine on the snapshot ticks, skips a snapshot that
 * agrees (`worldDigest`), and otherwise rewinds onto it (through `round3`) and replays — what
 * `GameController.reconcile` does in the world tier. Each rewind's correction is the client's own
 * pose before it against the pose after it, at the same tick: what the driver sees.
 *
 *   npx tsx scripts/zz-bb3d-wall-rollback.ts [seed] [ticks] [lead] [join]
 *   PATCH=5 npx tsx scripts/zz-bb3d-wall-rollback.ts ...   # the rule before SIM_PATCH 8 (3 on alpha: PATCH=2)
 *
 * Measured when written (12 seeds × 3600 ticks, join 30, lead 8): corrections over 0.1 in or 0.5°
 * 101 → 58, over 0.25 in or 1.5° 48 → 32, worst 2.46 → 0.87 in. Built from tick 0 instead (join 0)
 * every replay lands exactly on the room, which is what the `predict.ts` rollback checks measure.
 */
import { round3 } from '../server/wire';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
import { disposeEngineFor, rewindEngineTo, saveEngineState } from '../src/games/biobuzz/sim3d/engineImpl';
import { step3d } from '../src/games/biobuzz/sim3d/step3d';
import { digestsAgree, worldDigest, FULL_RESYNC_EVERY, type WorldDigest } from '../src/net/worldDigest';
import { restoreWireClocks } from '../src/net/wireClocks';
import { mkWorld3d, cmd } from './smoke-biobuzz/harness';
import { SIM_DT } from '../src/config';
import { robotExtents } from '../src/sim/physics';
import { BB_HALF_X, BB_HALF_Y } from '../src/games/biobuzz/config';
import type { RobotCommand, RobotState, World } from '../src/types';

await initPhysics();
await initPhysics3d();

const SEED = Number(process.argv[2] ?? 5);
const TICKS = Number(process.argv[3] ?? 3600);
const LEAD = Number(process.argv[4] ?? 8);
const JOIN = Number(process.argv[5] ?? 30);
const PATCH = process.env.PATCH ? Number(process.env.PATCH) : undefined;

let s = SEED * 7919 + 1;
const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);

/** the footprint's distance to the nearest perimeter wall (negative = into it) */
function wallGap(r: RobotState): number {
  const e = robotExtents(r);
  const cs = Math.cos(r.heading);
  const sn = Math.sin(r.heading);
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * cs;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * sn;
  const ax = Math.abs(hx * cs) + Math.abs(e.half * sn);
  const ay = Math.abs(hx * sn) + Math.abs(e.half * cs);
  return Math.min(BB_HALF_X - (cx + ax), cx - ax + BB_HALF_X, BB_HALF_Y - (cy + ay), cy - ay + BB_HALF_Y);
}

// the wall driver: ram a wall at an angle, then press / slide / turn on it, back off, pick another
const WALLS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
let wallN = WALLS[2];
let mode = { kind: 'away', until: 0, along: 0, rot: 0, mag: 1 };
function pick(t: number, r: RobotState): void {
  if ((mode.kind === 'away' || mode.kind === 'turn' || wallGap(r) > 6) && mode.kind !== 'ram') {
    wallN = WALLS[Math.floor(rnd() * 4)];
    mode = { kind: 'ram', until: t + 3 + rnd() * 1.5, along: (rnd() - 0.5) * 1.2, rot: (rnd() - 0.5) * 0.3, mag: 0.5 + rnd() * 0.5 };
    return;
  }
  const k = rnd();
  if (k < 0.4) mode = { kind: 'slide', until: t + 1 + rnd() * 2, along: (rnd() < 0.5 ? -1 : 1) * (0.4 + rnd() * 0.6), rot: 0, mag: 0.2 + rnd() * 0.8 };
  else if (k < 0.6) mode = { kind: 'turn', until: t + 0.5 + rnd(), along: 0, rot: (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.7), mag: rnd() * 0.6 };
  else if (k < 0.85) mode = { kind: 'press', until: t + 0.5 + rnd() * 1.5, along: (rnd() - 0.5) * 0.2, rot: 0, mag: 0.3 + rnd() * 0.7 };
  else mode = { kind: 'away', until: t + 0.4 + rnd() * 0.5, along: 0, rot: 0, mag: -1 };
}
function drive(t: number, r: RobotState): RobotCommand {
  if (t >= mode.until) pick(t, r);
  else if (mode.kind === 'ram' && wallGap(r) < 0.3 && t > mode.until - 2.5) pick(t, r);
  const dx = wallN.x * mode.mag - wallN.y * mode.along;
  const dy = wallN.y * mode.mag + wallN.x * mode.along;
  const cs = Math.cos(-r.heading);
  const sn = Math.sin(-r.heading);
  // robot-centric: stick up = forward, stick right = strafe right
  return cmd({ driveX: -(dx * sn + dy * cs), driveY: dx * cs - dy * sn, rotate: mode.rot });
}

const make = (): World => {
  const w = mkWorld3d('match', SEED);
  if (PATCH !== undefined) w.simPatch = PATCH;
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 1000;
  return w;
};
const clone = (w: World): World => JSON.parse(JSON.stringify(w)) as World;
const wire = (w: World): World => {
  const x = JSON.parse(JSON.stringify(w, round3)) as World;
  restoreWireClocks(x);
  return x;
};

// ---- the room ----
const W = make();
const cmds: RobotCommand[] = [];
const snaps = new Map<number, World>();
let joinW: World | null = null;
for (let t = 0; t < TICKS; t++) {
  const c = drive((W.tick + 1) * SIM_DT, W.robots[0]);
  cmds[W.tick + 1] = c;
  step3d(W, SIM_DT, new Map([[0, c]]));
  if (W.tick % 2 === 0) snaps.set(W.tick, wire(W));
  if (W.tick === JOIN) joinW = clone(W);
}
disposeEngineFor(W);

// ---- the client ----
let C = JOIN > 0 && joinW ? clone(joinW) : make();
let lastServer = 0;
let since = 0;
const digests = new Map<number, WorldDigest>();
const stepC = (): void => {
  step3d(C, SIM_DT, new Map([[0, cmds[C.tick + 1]]]));
  digests.set(C.tick, worldDigest(C));
  if ((C.tick - lastServer) % 2 === 0) saveEngineState(C, lastServer + 1);
};
const corr: { S: number; d: number; dh: number; gap: number }[] = [];
let rewinds = 0;
for (let S = Math.max(60, JOIN + 2); S + LEAD < TICKS; S += 2) {
  while (C.tick < S + LEAD) stepC();
  const snap = snaps.get(S)!;
  if (++since < FULL_RESYNC_EVERY) {
    const mine = digests.get(S);
    if (mine && digestsAgree(mine, worldDigest(snap))) {
      lastServer = S;
      continue;
    }
  }
  since = 0;
  const pre = { x: C.robots[0].pos.x, y: C.robots[0].pos.y, h: C.robots[0].heading };
  const next = clone(snap);
  if (!rewindEngineTo(C, next)) throw new Error('rewind refused');
  C = next;
  lastServer = S;
  digests.clear();
  rewinds++;
  while (C.tick < S + LEAD) stepC();
  const r = C.robots[0];
  corr.push({
    S,
    d: Math.hypot(pre.x - r.pos.x, pre.y - r.pos.y),
    dh: (Math.abs(Math.atan2(Math.sin(pre.h - r.heading), Math.cos(pre.h - r.heading))) * 180) / Math.PI,
    gap: wallGap(r),
  });
}
disposeEngineFor(C);

const over = (d: number, h: number): number => corr.filter((c) => c.d > d || c.dh > h).length;
console.log(
  `patch ${PATCH ?? 'live'} seed ${SEED} lead ${LEAD} join ${JOIN}: ${rewinds} rewinds; corrections >0.1in/0.5deg ${over(0.1, 0.5)}, ` +
    `>0.25in/1.5deg ${over(0.25, 1.5)}; worst ${Math.max(0, ...corr.map((c) => c.d)).toFixed(2)} in, ${Math.max(0, ...corr.map((c) => c.dh)).toFixed(1)} deg`,
);
for (const c of [...corr].sort((a, b) => b.d + b.dh / 10 - (a.d + a.dh / 10)).slice(0, 5)) {
  console.log(`  snapshot ${c.S}: ${c.d.toFixed(3)} in, ${c.dh.toFixed(2)} deg, ${c.gap.toFixed(2)} in from a wall`);
}
