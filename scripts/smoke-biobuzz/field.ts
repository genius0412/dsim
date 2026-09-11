import type { Artifact, RobotCommand, RobotSpec, World } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import { slimWorld, unslimWorld } from '../../src/net/protocol';
import { moduleFor } from '../../src/games';
import { simModuleFor } from '../../src/games/sim';
import { createChainWorld } from '../../src/games/chain/spawn';
import { chainStep } from '../../src/games/chain/step';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../../src/sim/spawn';
import { BB_BALL_SOLVER, BB_HALF_X, BB_HALF_Y, BB_POLLEN_R, BB_POLLEN_SIM } from '../../src/games/biobuzz/config';
import { BB_WALL_COUNT, biobuzzColliders } from '../../src/games/biobuzz/colliders';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { updateBiobuzz } from '../../src/games/biobuzz/play';
import { bbFootprint } from '../../src/games/biobuzz/robot';
import { BB_SCENES, bbSceneAt } from '../../src/games/biobuzz/scenes';
import { maxMatchTicks } from '../../src/sim/replay';
import type { ServerMsg } from '../../src/net/protocol';
import { Room, type Client } from '../../server/room';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { cmd, mkWorld, run, setup, type Check } from './harness';

/**
 * LANE A's smoke: THE FIELD.
 *
 * Registry integrity, the perimeter, containment, POLLEN conservation, determinism, the wire
 * round-trip, a headless server match, and the performance budget. Everything whose subject is
 * the field or the world rather than a mechanism.
 *
 * Every check here is one that would still be TRUE AND MEANINGFUL at Kickoff. Nothing asserts a
 * score, a zone or an element count, because Sections 8-11 of the V0 manual are placeholders
 * and a check written against a guess is worse than no check: it passes, so nobody looks, and
 * then it fails on Kickoff day for a reason that has nothing to do with a regression.
 */

/** The containment slop. `solveRobots` guarantees a robot that STARTED a tick inside cannot be
 * pushed out; it does not guarantee zero penetration at rest, because a soft contact resolves
 * over a few ticks. Half an inch is a resting contact; anything more is a robot leaving the
 * field, which is the bug this is looking for. */
const WALL_EPS = 0.5;

/** the robot's axis-aligned half-extents at its current heading — the same measure the
 * solver's containment invariant is stated in (footprint INCLUDING intake reach, not the bare
 * chassis), so this check cannot pass a robot whose sweeper is through the wall. */
function aabb(r: { pos: { x: number; y: number }; heading: number; spec: RobotSpec }): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  const e = bbFootprint(r.spec);
  const c = Math.cos(r.heading);
  const s = Math.sin(r.heading);
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * c;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * s;
  const ax = Math.abs(hx * c) + Math.abs(e.half * s);
  const ay = Math.abs(hx * s) + Math.abs(e.half * c);
  return { x0: cx - ax, x1: cx + ax, y0: cy - ay, y1: cy + ay };
}

const inBounds = (b: Artifact): boolean =>
  Math.abs(b.pos.x) <= BB_HALF_X - BB_POLLEN_R + 0.25 && Math.abs(b.pos.y) <= BB_HALF_Y - BB_POLLEN_R + 0.25;

export function fieldChecks(check: Check): void {
  // ── REGISTRY INTEGRITY ────────────────────────────────────────────────────
  // The module has to BE in the registry and be the right one. `moduleFor` falls back to
  // DECODE for an unknown id, which is the correct back-compat rule and also the reason this
  // check exists: an unregistered BIOBUZZ silently plays DECODE, and every other check in this
  // file would pass while testing the wrong game.
  {
    const mod = moduleFor('biobuzz');
    check('registry: moduleFor("biobuzz") resolves to the BIOBUZZ module', mod.id === 'biobuzz', `id=${mod.id}`);
    check('registry: BIOBUZZ declares scored:false (never persists ELO/records)', mod.scored === false);
    check('registry: BIOBUZZ declares startLegality:false (no published G304 analogue)', mod.startLegality === false);
    check(
      'registry: bounds are the 144x144 field',
      mod.bounds.halfX === BB_HALF_X && mod.bounds.halfY === BB_HALF_Y,
      `${mod.bounds.halfX}x${mod.bounds.halfY}`,
    );
    check('registry: every UI renderer slot is filled', typeof mod.drawField === 'function' && typeof mod.drawBalls === 'function' && typeof mod.drawRobot === 'function');
  }

  // ── THE PERIMETER ─────────────────────────────────────────────────────────
  {
    check('field: exactly four perimeter walls', BB_WALL_COUNT === 4, `count=${BB_WALL_COUNT}`);
    check('field: no dynamic colliders (BIOBUZZ has no known moving geometry)', biobuzzColliders.dynamic === undefined);
    // Every wall's INNER FACE must sit exactly on the bound it is the wall for. A wall placed
    // a hair inside shrinks the field silently; a hair outside leaves a gap a pollen rests in.
    const faces = biobuzzColliders.statics.map((w) =>
      w.hx < w.hy ? Math.abs(w.tx) - w.hx : Math.abs(w.ty) - w.hy,
    );
    check(
      'field: every wall inner face sits exactly on the field bound',
      faces.every((f, i) => Math.abs(f - (i < 2 ? BB_HALF_X : BB_HALF_Y)) < 1e-9),
      faces.join(', '),
    );
  }

  // ── WALL CONTAINMENT: drive at each wall for 3 s ──────────────────────────
  // Three seconds is well past however long the drivetrain needs to reach top speed and pin,
  // so this is a check on the SOLVER's containment invariant rather than on acceleration.
  // Each heading is run in its own world: a robot that has already been slammed into one wall
  // is not a clean starting state for the next.
  for (const [name, headingDeg, at] of [
    ['+x', 0, { x: 40, y: 0 }],
    ['-x', 180, { x: -40, y: 0 }],
    ['+y', 90, { x: 0, y: 40 }],
    ['-y', 270, { x: 0, y: -40 }],
  ] as const) {
    const w = mkWorld('free', 7);
    const r = w.robots[0];
    r.pos = { ...at };
    r.heading = (headingDeg * Math.PI) / 180;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: 1 }), 3);
    const b = aabb(r);
    const ok =
      b.x0 >= -BB_HALF_X - WALL_EPS &&
      b.x1 <= BB_HALF_X + WALL_EPS &&
      b.y0 >= -BB_HALF_Y - WALL_EPS &&
      b.y1 <= BB_HALF_Y + WALL_EPS;
    check(
      `containment: driving at the ${name} wall for 3 s keeps the footprint inside bounds`,
      ok,
      `x ${b.x0.toFixed(2)}..${b.x1.toFixed(2)} · y ${b.y0.toFixed(2)}..${b.y1.toFixed(2)}`,
    );
  }

  // ── THE START ANCHORS ARE INSIDE THE FIELD ────────────────────────────────
  /**
   * A robot spawned at any anchor, in either alliance, must be fully inside `bounds` BEFORE
   * anything steps.
   *
   * The anchors are hand-placed APPROX numbers (there is no published BIOBUZZ start geometry —
   * `startLegality: false`), and an anchor an inch too far out spawns a robot intersecting the
   * wall, which Rapier then resolves by shoving it — so the match begins with four robots
   * sliding. This is the cheapest possible guard on a number a human typed, and it is checked
   * on the FOOTPRINT, so an anchor that fits a bare chassis but not its sweeper fails here.
   */
  {
    const w = createBiobuzzWorld('match', 4, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', {}, 1),
      setup(2, 'red', {}, 0),
      setup(3, 'red', {}, 1),
    ]);
    check('anchors: BIOBUZZ spawns four robots', w.robots.length === 4);
    for (const r of w.robots) {
      const b = aabb(r);
      const slack = Math.min(BB_HALF_X - Math.max(Math.abs(b.x0), Math.abs(b.x1)), BB_HALF_Y - Math.max(Math.abs(b.y0), Math.abs(b.y1)));
      check(
        `anchors: robot ${r.id} (${r.alliance}) starts fully inside bounds`,
        slack >= 0,
        `slack=${slack.toFixed(2)}"`,
      );
    }
    // The two anchors per alliance exist so an alliance's robots cannot spawn on top of each
    // other; a mirrored pair that collapsed to one point would pass every other check here.
    const blue = w.robots.filter((r) => r.alliance === 'blue');
    check(
      'anchors: the two anchors of an alliance are distinct',
      Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y) > 18,
      `apart=${Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y).toFixed(1)}"`,
    );
    // RED IS THE X-MIRROR OF BLUE, applied once in `spawn.ts`. Asserted because a second
    // mirror anywhere else would cancel this one and put both alliances on the same side.
    const red = w.robots.filter((r) => r.alliance === 'red');
    check(
      'anchors: RED is the x-mirror of BLUE',
      Math.abs(blue[0].pos.x + red[0].pos.x) < 1e-9 && Math.abs(blue[0].pos.y - red[0].pos.y) < 1e-9,
      `blue=${blue[0].pos.x},${blue[0].pos.y} red=${red[0].pos.x},${red[0].pos.y}`,
    );
  }

  // ── POLLEN CONSERVATION, UNDER BOTH SOLVERS ───────────────────────────────
  /**
   * A POLLEN MUST NEVER VANISH. That is the invariant the whole `BB_BALL_SOLVER` decision has
   * to be judged under: both models are allowed to disagree about what a squeezed ball DOES,
   * and neither is allowed to delete it. Deletion is the failure mode a penetration test
   * eventually reaches on its own, and it is invisible in a screenshot.
   *
   * The loop drives `updateBiobuzz` DIRECTLY with an explicit solver argument, and sweeps the
   * robot KINEMATICALLY rather than through the drivetrain. That is deliberate on both counts:
   *  • the solver is a parameter of `updateBiobuzz`, not of `biobuzzStep` (the step reads the
   *    config constant), so the non-default arm is only reachable this way;
   *  • writing the robot's pose makes the sweep identical between the two runs, so any
   *    difference in the outcome is the POLLEN MODEL and not two slightly different drives.
   * The default solver's behaviour under the FULL pipeline is covered by the determinism and
   * scene checks below.
   */
  for (const solver of ['bespoke', 'rapier'] as const) {
    const w = createBiobuzzWorld('free', 11, []);
    const rob = createBiobuzzWorld('free', 11, [setup(0, 'blue')]).robots[0];
    w.robots.push(rob);
    rob.heading = 0;
    rob.pos = { x: -BB_HALF_X + 12, y: 0 };
    const n0 = w.balls.length;
    const cmds = new Map<number, RobotCommand>([[rob.id, cmd({ driveY: 1, intake: false })]]);
    for (let i = 0; i < 600; i++) {
      // 40 in/s straight across the field, by hand. The sweep ORIGIN is captured before the
      // pose is written, exactly as `step.ts` stage 0 does it — without it the Rapier arm
      // gets no `from`, falls back to the end pose, and the chassis is spawned already
      // overlapping whatever it drove into (the "balls go on top of the robot" failure).
      const from = new Map([[rob.id, { x: rob.pos.x, y: rob.pos.y, heading: rob.heading }]]);
      rob.pos = { x: rob.pos.x + 40 * C.SIM_DT, y: 0 };
      rob.vel = { x: 40, y: 0 };
      w.tick++;
      w.time += C.SIM_DT;
      updateBiobuzz(w, C.SIM_DT, cmds, true, from, solver);
    }
    check(
      `pollen [${solver}]: count conserved over 600 ticks of a robot sweeping the field`,
      w.balls.length === n0 && n0 === BB_POLLEN_SIM,
      `${n0} -> ${w.balls.length}`,
    );
    const out = w.balls.filter((b) => b.state.kind === 'ground' && !inBounds(b));
    check(
      `pollen [${solver}]: every ground pollen still inside the field`,
      out.length === 0,
      out.length ? `${out.length} out, worst ${JSON.stringify(out[0].pos)}` : '',
    );
  }
  check(`pollen: BB_BALL_SOLVER is "${BB_BALL_SOLVER}" (P0.5 picks the survivor)`, true);

  // ── DETERMINISM ───────────────────────────────────────────────────────────
  // Same seed, same setups, same commands ⇒ the same world, bit for bit as `worldHash` reads
  // it. This is THE check the multiplayer lockstep and every replay depend on, and a scatter
  // built off `world.rngState` is exactly the kind of thing that breaks it silently.
  {
    const setups = [setup(0, 'blue'), setup(1, 'red', {}, 1)];
    const a = createBiobuzzWorld('match', 12345, setups);
    const b = createBiobuzzWorld('match', 12345, setups);
    check('determinism: same seed ⇒ identical worldHash at spawn', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const c = cmd({ driveY: 1, intake: true });
    const cmds = new Map([[0, c], [1, c]]);
    for (let i = 0; i < 600; i++) {
      biobuzzStep(a, C.SIM_DT, cmds);
      biobuzzStep(b, C.SIM_DT, cmds);
    }
    check('determinism: same seed ⇒ identical worldHash after 600 ticks', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const d = createBiobuzzWorld('match', 999, setups);
    check('determinism: a DIFFERENT seed gives a different world (the scatter is really seeded)', worldHash(d) !== worldHash(a));
  }

  // ── THE WIRE ROUND-TRIP ───────────────────────────────────────────────────
  /**
   * `slimWorld` strips the balls (they ride their own delta channel) and every robot's static
   * spec, then `unslimWorld` puts both back. What must survive that is `game` and the whole
   * `biobuzz` state bag — if either is dropped, a joining client resolves the module to DECODE
   * and renders a BIOBUZZ world with DECODE's field, which is the exact failure the `game`
   * field was added for.
   */
  {
    const w = createBiobuzzWorld('match', 77, [setup(0, 'blue')]);
    w.biobuzz!.scored.blue = 3;
    w.biobuzz!.held[0] = 2;
    const slim = slimWorld(w);
    const back = unslimWorld(slim, w.balls, () => w.robots[0].spec);
    check('wire: slim/unslim preserves world.game', back.game === 'biobuzz', `game=${back.game}`);
    check('wire: slim/unslim preserves the whole world.biobuzz bag', JSON.stringify(back.biobuzz) === JSON.stringify(w.biobuzz));
    check('wire: slim/unslim preserves the pollen count', back.balls.length === w.balls.length);
    check('wire: the round-tripped world hashes the same', worldHash(back) === worldHash(w));
  }

  // ── EVERY FIELD SCENE HASHES DETERMINISTICALLY ────────────────────────────
  /**
   * A scene is a determinism check for free: step it to its last still twice and the two
   * worlds must hash the same. The value is that it covers the FULL pipeline over hundreds of
   * ticks with pollen piled in corners and robots pinned against walls — situations nobody
   * would hand-write an assertion for, and exactly where a non-deterministic tie-break
   * (iteration order in the separator, a `Math.random`, a `Date.now`) actually hides.
   */
  for (const scene of BB_SCENES.filter((s) => s.lane === 'field')) {
    const last = Math.max(...scene.stills);
    const h1 = worldHash(bbSceneAt(scene, last));
    const h2 = worldHash(bbSceneAt(scene, last));
    check(`scene [${scene.id}@${last}]: hashes deterministically`, h1 === h2, `${h1} vs ${h2}`);
  }

  // ── PERFORMANCE BUDGET ────────────────────────────────────────────────────
  /**
   * A 2v2 BIOBUZZ world must not cost more than 1.2x a 2v2 Chain Reaction world per step,
   * MEASURED IN THE SAME RUN.
   *
   * Same run matters more than the threshold does: an absolute millisecond budget is a
   * statement about the machine that happened to run CI, and it either fails on a loaded
   * laptop or passes on anything. A RATIO against a game already known to hold 60 Hz on the
   * hardware people actually play on is a statement about this game.
   *
   * Both sides get a warm-up before the timed window so the comparison is not
   * "interpreted BIOBUZZ vs JIT-compiled CR", which is a ~3x artefact and was the first
   * version of this check.
   */
  {
    const bbSetups = [setup(0, 'blue'), setup(1, 'blue', {}, 1), setup(2, 'red'), setup(3, 'red', {}, 1)];
    const crSetup = (id: number, alliance: 'red' | 'blue', startIndex: number) => ({
      id,
      alliance,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
      startIndex,
    });
    const crSetups = [crSetup(0, 'blue', 0), crSetup(1, 'blue', 1), crSetup(2, 'red', 0), crSetup(3, 'red', 1)];
    const drive = cmd({ driveY: 1, rotate: 0.3, intake: true, fire: true });
    const cmds = new Map([0, 1, 2, 3].map((id) => [id, drive] as const));

    const time = (build: () => World, step: (w: World, dt: number, c: Map<number, RobotCommand>) => void): number => {
      const warm = build();
      for (let i = 0; i < 300; i++) step(warm, C.SIM_DT, cmds as Map<number, RobotCommand>);
      const w = build();
      const t0 = performance.now();
      const n = 1200;
      for (let i = 0; i < n; i++) step(w, C.SIM_DT, cmds as Map<number, RobotCommand>);
      return (performance.now() - t0) / n;
    };
    const cr = time(() => createChainWorld('match', 5, crSetups), chainStep);
    const bb = time(() => createBiobuzzWorld('match', 5, bbSetups), biobuzzStep);
    check(
      'perf: a 2v2 BIOBUZZ step costs <= 1.2x a 2v2 Chain Reaction step',
      bb <= cr * 1.2,
      `bb=${bb.toFixed(3)}ms cr=${cr.toFixed(3)}ms ratio=${(bb / cr).toFixed(2)}`,
    );
  }
}

/**
 * THE SERVER SIDE: real `Room`s configured for BIOBUZZ run whole headless matches.
 *
 * Split out of `fieldChecks` because it imports `server/**`, and a lane file that pulls the
 * server in is a lane file that cannot run in a browser context.
 *
 * WHAT IT PROVES, and it is more than it looks: the authoritative server can host this game
 * at all. `Room` resolves the game through the DOM-FREE registry (`games/sim.ts`), steps it
 * with that module's `step`, slims it over the wire, and finalizes it — so anything in the
 * BIOBUZZ pipeline that only breaks WITHOUT a DOM (a stray `document`, a `window`, a
 * renderer import leaking into `sim.ts`) fails HERE and nowhere else. It is also the only
 * check that runs the whole two-minute match clock, phases and all, to `post`.
 *
 * `advanceForTest` pumps ticks synchronously with the real-time timer dropped, which is what
 * makes a two-minute match take a fraction of a second.
 */
export function roomChecks(check: Check): void {
  /** four drivers, 2v2, the roster a versus room is built for. */
  const roster = (): { id: string; alliance: 'blue' | 'red'; startIndex: number }[] => [
    { id: 'bb-b1', alliance: 'blue', startIndex: 0 },
    { id: 'bb-b2', alliance: 'blue', startIndex: 1 },
    { id: 'bb-r1', alliance: 'red', startIndex: 0 },
    { id: 'bb-r2', alliance: 'red', startIndex: 1 },
  ];

  const mkClient = (
    seat: { id: string; alliance: 'blue' | 'red'; startIndex: number },
    spec: RobotSpec,
    sink: ServerMsg[],
  ): Client => ({
    id: seat.id,
    send: (m: ServerMsg) => sink.push(m),
    player: {
      clientId: seat.id,
      name: seat.id,
      teamName: 'Smoke',
      teamNumber: 1,
      alliance: seat.alliance,
      startIndex: seat.startIndex,
      ready: true,
      spec: { ...spec },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  });

  /** a started room for `game` (2v2 unless `seats` says otherwise), plus the message log of
   *  its first seat. */
  const started = (
    code: string,
    game: 'biobuzz' | 'chain',
    spec: RobotSpec,
    onOutcome?: (game: string | undefined) => void,
    seats = roster(),
  ): { room: Room; msgs: ServerMsg[] } => {
    const msgs: ServerMsg[] = [];
    const room = new Room(code, () => {}, { kind: 'versus', game }, (o) => onOutcome?.(o.game));
    for (const seat of seats) room.add(mkClient(seat, spec, seat.id === 'bb-b1' ? msgs : []));
    room.onMessage('bb-b1', { t: 'start' });
    return { room, msgs };
  };

  // ── A FULL HEADLESS BIOBUZZ MATCH ─────────────────────────────────────────
  let outcomeGame: string | undefined = '<onResult never called>';
  let threw: unknown = null;
  let room: Room | null = null;
  let msgs: ServerMsg[] = [];
  try {
    const r = started('smoke-bb', 'biobuzz', BB_DEFAULT_SPEC, (g) => {
      outcomeGame = g;
    });
    room = r.room;
    msgs = r.msgs;
    // +5 past the cap: the last ticks are what finalize the match, and stopping exactly at
    // the cap would test everything except the transition this check is named for.
    room.advanceForTest(maxMatchTicks() + 5);
  } catch (e) {
    threw = e;
  }
  check(
    'room: a 2v2 BIOBUZZ room starts and runs a full match without throwing',
    threw === null,
    threw ? String(threw) : '',
  );
  if (threw !== null || !room) return;

  const start = msgs.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('room: matchStart advertises game:"biobuzz"', start?.game === 'biobuzz', `game=${start?.game}`);
  check('room: matchStart carries all four setups', start?.setups.length === 4, `n=${start?.setups.length}`);

  // The wire snapshot has to say WHICH GAME it is, because that is the client's fallback when
  // it joined without a `matchStart` (a reconnect, a spectator) — a snapshot that forgets
  // `game` renders BIOBUZZ with the DECODE module and looks almost right.
  const snaps = msgs.filter((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[];
  check('room: the room broadcasts snapshots', snaps.length > 0, `n=${snaps.length}`);
  check(
    'room: every snapshot is tagged game:"biobuzz"',
    snaps.length > 0 && snaps.every((m) => m.w.game === 'biobuzz'),
    `games=${[...new Set(snaps.map((m) => m.w.game))].join(',')}`,
  );

  // REACHING `post` IS THE POINT. `matchResult` is broadcast from the finalizer, so its
  // presence is the proof the match ran the clock out and ended instead of stalling.
  const res = msgs.find((m) => m.t === 'matchResult') as Extract<ServerMsg, { t: 'matchResult' }> | undefined;
  check('room: the BIOBUZZ match reaches post and broadcasts matchResult', !!res);
  check(
    'room: the finished BIOBUZZ match scored nothing (an unscored shell must stay 0-0)',
    res?.result.score.blue === 0 && res?.result.score.red === 0,
    `blue=${res?.result.score.blue} red=${res?.result.score.red}`,
  );
  // The outcome still has to be GAME-TAGGED even though nothing is written: it is what
  // `persistMatch` reads to decide to skip, and an absent `game` defaults to DECODE — which
  // would file a BIOBUZZ run onto the DECODE boards.
  check('room: the MatchOutcome carries game:"biobuzz"', outcomeGame === 'biobuzz', `game=${outcomeGame}`);
  check(
    'room: the SERVER-SAFE registry declares BIOBUZZ unscored, so persistMatch skips it',
    simModuleFor('biobuzz').scored === false,
  );

  // -- THE START-POSE DE-CONFLICT LOOP READS THIS GAME'S ANCHOR COUNT ------------
  /**
   * FOUR ROBOTS ON ONE ALLIANCE, every one of them asking for anchor 0.
   *
   * `Room` de-conflicts start poses per alliance by walking the index forward until it finds
   * an unused one, stopping after a full cycle so an over-full alliance reuses a pose rather
   * than spinning the tick loop forever. That walk used DECODE's five anchors for every game,
   * so a BIOBUZZ alliance of four was handed 0, 1, 2 and 3 against TWO anchors: indices 2 and
   * 3 do not exist in this game and resolve to whatever its spawn does with a miss. It now
   * reads `simModuleFor(this.game).startPoseCount`.
   *
   * Four on ONE alliance and all at index 0 is what makes the check bite: a 2v2 at 0/1/0/1
   * never walks the index at all, which is why the full-match check above passed throughout.
   * With the bug: 0, 1, 2, 3. Without it: 0, 1, 0, 0 (the cycle gives up and reuses).
   */
  {
    const seats = (['bb-b1', 'bb-b2', 'bb-b3', 'bb-b4'] as const).map((id) => ({
      id,
      alliance: 'blue' as const,
      startIndex: 0,
    }));
    const n = simModuleFor('biobuzz').startPoseCount;
    const { msgs: m4 } = started('smoke-bb-anchors', 'biobuzz', BB_DEFAULT_SPEC, undefined, [...seats]);
    const st = m4.find((x) => x.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    const idx = (st?.setups ?? []).map((x) => x.startIndex ?? 0);
    check(
      `room: a 4-robot BIOBUZZ alliance is only ever assigned anchors 0..${n - 1}`,
      idx.length === 4 && idx.every((v) => Number.isInteger(v) && v >= 0 && v < n),
      `startPoseCount=${n} assigned=[${idx.join(', ')}]`,
    );
  }


  // ── PERFORMANCE, ROOM AGAINST ROOM, IN THE SAME RUN ───────────────────────
  /**
   * The same 1.2x budget as the world-step check above, but measured through the SERVER's
   * whole per-tick path: input draining, the step, `slimWorld`, the ball delta and the
   * broadcast to four sockets. That is the cost that actually decides whether a machine can
   * host a room, and it is not the same shape as the step cost — a game whose step is cheap
   * but whose snapshot is fat fails here and passes there.
   *
   * Both rooms are built and warmed inside this block so the comparison is same-run,
   * same-process, same-JIT state, for the reason spelled out on the world-step check.
   */
  {
    const WARM = 300;
    const N = 1200;
    const timeRoom = (code: string, game: 'biobuzz' | 'chain', spec: RobotSpec): number => {
      started(`${code}-warm`, game, spec).room.advanceForTest(WARM);
      const timed = started(code, game, spec).room;
      const t0 = performance.now();
      timed.advanceForTest(N);
      return (performance.now() - t0) / N;
    };
    const cr = timeRoom('smoke-perf-cr', 'chain', DEFAULT_SPEC);
    const bb = timeRoom('smoke-perf-bb', 'biobuzz', BB_DEFAULT_SPEC);
    check(
      'perf: a 2v2 BIOBUZZ ROOM tick costs <= 1.2x a 2v2 Chain Reaction room tick',
      bb <= cr * 1.2,
      `bb=${bb.toFixed(3)}ms cr=${cr.toFixed(3)}ms ratio=${(bb / cr).toFixed(2)}`,
    );
  }
}
