import type { Artifact, ArtifactColor, RobotSpec, RobotState, World } from '../../types';
import { BB_FLOWERS, BB_HALF_X, BB_HIVE_CELL_DY, BB_HIVE_X, BB_HOOD_DEFAULT_DEG, BB_NECTAR_R, BB_POLLEN_R } from './config';
import { capturePollen } from './elements';
import { type BbLauncherSpec, bbFoldTwinMount, bbResolveMount2 } from './mechs';
import { BB_MOUNT_POSITIONS, BB_SCORE_MODES, BB_SHOOTER_EDGES, type BbMountPos, type BbScoreMode } from './mounts';
import { bbFootprint, bbHopperCap } from './robot';
import { bbCmd, bbRow, bbSetup, bbThrottle, bbWorld, type Scene } from './scenes';
import { BB_DEFAULT_SPEC } from './robotConfig';

/**
 * LANE B's SCENES — the ROBOT: what the mechanisms do, and what every build LOOKS LIKE.
 *
 * Two kinds of scene live here, and they answer two different questions.
 *
 * ── MECHANISM SCENES: does the hardware do what it draws? ──────────────────
 * `intake-line`, `launch-wall-bounce`, `turret-acquire`, `boxtube-place`, `dumper-hive` and
 * `double-turret-feed`. Each drives one mechanism through the real step and is aimed at the SAME
 * class of bug: the renderer and the sim deriving the same geometry twice and disagreeing. If the
 * sweeper collects an element that never touched the drawn rollers, a launch leaves from somewhere
 * no turret is, or the placement marker sits somewhere the FLOWER reach test does not, these cells
 * show it and nothing else does.
 *
 * ── ARCHETYPE SHEETS: does every buildable robot read correctly? ───────────
 * One scene per launcher × mount, each holding the same build at three chassis sizes: nine cells
 * for a single turret, eight for a double turret (its POLLEN turret may not sit at `center`, which
 * neighbours every cell — the coercer folds it to `front`, so a `center` sheet would be a second
 * copy of the `front` one), and four edges for a dumper. 21 sheets, the complete space of BIOBUZZ
 * launchers. A sprite bug — a dumper on the wrong edge, a corner turret hanging off the frame, two
 * turrets overlapping — lives in exactly one of those combinations.
 *
 * Every sheet robot also carries a Box Tube (requested at the back, folded around the launcher by
 * the coercer) and a full hopper, so the placement marker and the held-element discs are checked
 * against every launcher layout too.
 *
 * The gallery draws each sheet's robots TWICE: the in-match canvas sprite and the builder's SVG
 * preview, side by side. They are two renderers reading one geometry (`bbMouths`,
 * `bbFootprint`, `turretLocal`, `bbPlacePointLocal`), so any difference between the two pictures
 * is a real divergence.
 */

/** POLLEN ids start at 1 — see the note in `scenesField.ts`. */
const ID0 = 1;

/**
 * The three chassis sizes every archetype sheet shows, as REQUESTED square footprints.
 *
 * 12 and 18 are both outside what BIOBUZZ can build, and that is deliberate: the coercer
 * clamps them to the floor and the ceiling of the legal envelope, so the outer two cells are
 * always "the smallest robot this build can be" and "the largest", whatever the envelope
 * currently is. Hard-coding the resolved numbers instead would silently stop tracking
 * `bbSizeLimits` the day an intake's reach changes.
 */
const SHEET_SIZES = [12, 15, 18] as const;

/**
 * Where the three sheet robots stand: spread along the field's Y axis, on x = 0.
 *
 * ALONG Y, NOT X, and that is a fact about the CAMERA rather than about the field. Every cell
 * is drawn at the blue drive-station view angle, which maps world +x to SCREEN DOWN and world
 * +y to screen right, so along y the three sizes read left-to-right, smallest first.
 *
 * 34" apart: the largest legal chassis is 17" wide, so there are ~13" of tile between
 * neighbours and no sweeper can touch the robot beside it — while still keeping all three
 * inside the zoomed window the gallery draws a sheet in.
 */
const SHEET_Y = [-34, 0, 34] as const;

/**
 * Every sheet robot faces SCREEN UP (heading 180° = world −x = up in the blue view), so the
 * canvas sprite and the builder's SVG preview (front at the TOP of its viewBox) point the same
 * way and the two pictures can be compared without mentally flipping one.
 */
const SHEET_HEADING_DEG = 180;

// ─────────────────────────────────────────────────────────────────────────────
// WORLD-CONSTRUCTION HELPERS — called only inside `build` (see the cycle rule in `scenes.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/** one loose element of `color` at (x, y), at its real radius. */
function element(id: number, color: ArtifactColor, x: number, y: number): Artifact {
  return {
    id,
    color,
    r: color === 'yellow' ? BB_POLLEN_R : BB_NECTAR_R,
    state: { kind: 'ground' },
    pos: { x, y },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
  };
}

/** the next unused element id, kept on the world so a launched element cannot alias one. */
function nextId(world: World): number {
  const id = Math.max(world.biobuzz?.nextBallId ?? 1, world.balls.reduce((m, b) => Math.max(m, b.id + 1), ID0));
  if (world.biobuzz) world.biobuzz.nextBallId = id + 1;
  return id;
}

/**
 * EMPTY EVERY HOPPER — for a scene that REPLACES the staged balls (`bbWorld(seed, setups, [])`).
 *
 * ⚠️ WITHOUT THIS A REPLACED WORLD HAS PHANTOM ELEMENTS. The spawn preloads four POLLEN per robot
 * through `capturePollen`, so `r.hopper` holds four colours whose held balls `bbWorld` has just
 * thrown away. The hopper then reads FULL with nothing in it: the intake refuses everything
 * (`intake-line` collected nothing), a launch finds no held ball to release (`launch-wall-bounce`
 * fired nothing), and the sprite drew four held discs that do not exist.
 */
function emptyHoppers(world: World): void {
  for (const r of world.robots) r.hopper.length = 0;
}

/**
 * LOAD `r` with new elements of `colors`, in order (the LAST is the next to leave), through the
 * real `capturePollen` — so a colour the build's intake refuses (NECTAR on a single turret, or the
 * other alliance's) is simply not taken. Never past the hopper cap. For a REPLACED world only: the
 * elements are created, so a staged world would stop conserving its count.
 */
function loadHopper(world: World, r: RobotState, colors: readonly ArtifactColor[]): void {
  const cap = bbHopperCap(r.spec);
  for (const c of colors) {
    if (r.hopper.length >= cap) break;
    const ball = element(nextId(world), c, r.pos.x, r.pos.y);
    world.balls.push(ball);
    if (!capturePollen(world, r, ball)) world.balls.pop();
  }
}

/**
 * RE-LOAD `r` in a STAGED world, CONSERVING every element: its four preloaded POLLEN are taken
 * back out, then `colors` are captured in order — POLLEN from those preloads, NECTAR from its own
 * alliance's human-player STOCK (`nectarStock` is decremented to match, exactly as an entry would).
 * Preloads left over are set down on the tiles at `(spare.x, spare.y)`, one diameter apart.
 */
function restock(world: World, r: RobotState, colors: readonly ArtifactColor[], spare: { x: number; y: number }): void {
  const pool = world.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id);
  r.hopper.length = 0;
  for (const b of pool) b.state = { kind: 'ground' };
  let si = 0;
  for (const c of colors) {
    let ball: Artifact | undefined;
    if (c === 'yellow') {
      ball = pool.shift();
    } else {
      ball = world.balls.find((b) => b.color === c && b.state.kind === 'stock' && b.state.alliance === c);
      if (ball && world.biobuzz) world.biobuzz.nectarStock[c as 'red' | 'blue'] -= 1;
    }
    if (!ball) continue;
    ball.state = { kind: 'ground' };
    ball.pos = { x: r.pos.x, y: r.pos.y };
    capturePollen(world, r, ball);
  }
  for (const b of pool) {
    b.pos = { x: spare.x + si * BB_POLLEN_R * 2.2, y: spare.y };
    b.vel = { x: 0, y: 0 };
    si++;
  }
}

/** a launcher container for a scene spec. A DOUBLE turret's NECTAR turret is resolved the way the
 * coercer resolves an absent one — `mount`'s fixed partner cell — unless `mount2` is named. */
function launcherOf(kind: BbScoreMode, mount: BbMountPos, mount2?: BbMountPos): BbLauncherSpec {
  return kind === 'twinturret'
    ? { kind, mount, mount2: bbResolveMount2(mount, mount2), hoodDeg: BB_HOOD_DEFAULT_DEG }
    : { kind, mount, hoodDeg: BB_HOOD_DEFAULT_DEG };
}

/** the scene spec fields for a loadout — the container AND the flat mirror, the same shape the
 * coercer writes. */
function loadout(kind: BbScoreMode, mount: BbMountPos, tube: BbMountPos | null, mount2?: BbMountPos): Partial<RobotSpec> {
  return {
    scoreMode: kind,
    shooterMount: mount,
    bbMech: { launcher: launcherOf(kind, mount, mount2), lift: tube ? { kind: 'vslide', mount: tube } : null },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHETYPE SHEETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One archetype sheet: the same build at three sizes, standing still, facing up the screen.
 *
 * ── WHY `build` REACHES INTO THE WORLD AFTERWARDS ──────────────────────────
 * It points every turret STRAIGHT AHEAD and fills every hopper. `turretHeading` is a world-frame
 * angle and a fresh turret spawns aimed at field CENTRE, so three robots at three places would
 * spawn with three different turret angles — and the sheet's whole job is that the three cells
 * differ ONLY by chassis size. The hopper is filled (POLLEN, alternating with the robot's own
 * NECTAR for a build that carries it) so the held-element discs are on every sheet. Both are
 * world CONSTRUCTION, which a scene owns; neither is a step-time mutation.
 */
function archetypeScene(mode: BbScoreMode, mount: BbMountPos): Scene {
  const launcher = launcherOf(mode, mount);
  const second = launcher.mount2 ? ` · NECTAR turret ${launcher.mount2}` : '';
  return {
    id: `archetype-${mode}-${mount}`,
    title: `${mode} · ${mount} launcher${second} · box tube · front sweeper · smallest / 15" / largest legal chassis`,
    lane: 'robot',
    build: (seed): World => {
      // INTAKE MOUNT FIXED AT FRONT across every sheet. The sweeper mount is its own dimension
      // of the space and crossing the two would be 84 sheets; front is the mount every archetype
      // is normally built with, so it is the one that has to read perfectly.
      const spec = (size: number): Partial<RobotSpec> => ({
        ...loadout(mode, mount, 'back'),
        intakeMount: 'front',
        length: size,
        width: size,
      });
      const world = bbWorld(
        seed,
        SHEET_SIZES.map((size, i) =>
          bbSetup(i, 'blue', { x: 0, y: SHEET_Y[i], headingDeg: SHEET_HEADING_DEG }, spec(size)),
        ),
        [], // no loose elements: a sheet is about the robot, and loose balls would obscure the sweeper
      );
      emptyHoppers(world);
      for (const r of world.robots) {
        r.turretHeading = r.heading;
        // a DOUBLE turret's NECTAR turret is a second individual turret — point it the same way
        if (r.bbTurret2Heading !== undefined) r.bbTurret2Heading = r.heading;
        loadHopper(world, r, mode === 'turret' ? ['yellow', 'yellow', 'yellow', 'yellow'] : ['yellow', 'blue', 'yellow', 'blue']);
      }
      return world;
    },
    // ONE STILL, at tick 0. Nothing moves in a sheet.
    stills: [0],
  };
}

/** every launcher × every mount it can actually be built at: nine cells for a single turret,
 * the eight non-centre cells for a double turret (see the file header), four edges for a dumper. */
const ARCHETYPE_SHEETS: readonly Scene[] = BB_SCORE_MODES.flatMap((mode) => {
  const mounts: readonly BbMountPos[] =
    mode === 'turret'
      ? BB_MOUNT_POSITIONS
      : mode === 'twinturret'
        ? BB_MOUNT_POSITIONS.filter((p) => bbFoldTwinMount(p) === p)
        : BB_SHOOTER_EDGES;
  return mounts.map((mount) => archetypeScene(mode, mount));
});

/** F3 (the right wall, blue's half) and F4 (the audience wall, blue's half) — `boxtube-place`'s
 * two FLOWERS, looked up by id so a reordering of `BB_FLOWERS` cannot silently retarget it. */
const flowerById = (id: string) => BB_FLOWERS.find((f) => f.id === id)!;

export const BB_ROBOT_SCENES: readonly Scene[] = [
  {
    id: 'intake-line',
    title: 'Drive a running sweeper along a line of 10 pollen at 45 in/s',
    lane: 'robot',
    /**
     * THE CAPTURE INVARIANT, as a picture: THE DRAWN MOUTHS ARE THE CAPTURE AREAS.
     *
     * A line rather than a pile, and spaced 7" apart, so each POLLEN is captured as a SEPARATE
     * event a still can be attributed to. It also runs the hopper to its CAP (the default dial, 4), so the
     * back half of the line must be plowed rather than collected — and a robot that keeps eating
     * past its cap is a bug this scene shows for free. The held discs on the deck count up as the
     * line shortens.
     */
    build: (seed) => {
      // ON y = −36, CLEAR OF THE HIVE FRAME. The frame's floor bars run along y at x = ±24..25
      // for |y| <= 19.4, and a robot cannot drive over one: on y = 0 this robot was stopped dead
      // by red's bar at x = −25 after one POLLEN, and every later still was the same picture.
      const world = bbWorld(seed, [bbSetup(0, 'blue', { x: -50, y: -36, headingDeg: 0 })], bbRow(ID0, 10, -30, -36, 33, -36));
      emptyHoppers(world);
      return world;
    },
    script: () => ({ 0: bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, 45), intake: true }) }),
    stills: [0, 45, 120, 240],
  },

  {
    id: 'launch-wall-bounce',
    title: 'A dumper empties a full hopper at the wall',
    lane: 'robot',
    /**
     * A FULL HOPPER, FIRED AT A WALL FROM 20", and then left alone to see what comes back.
     *
     *  • WHERE THE POLLEN LEAVE FROM — a dumper throws its whole load across its firing edge in
     *    one tick, so the launch line is drawn in POLLEN. With no HIVE on its open side it throws
     *    straight over the edge at the default speed.
     *  • THE BALLISTIC ARC — flight elements carry a `z` and a shadow.
     *  • THE BOUNCE — `BB_POLLEN_WALL_REST` is an APPROX guess, judged by watching it; the last
     *    still is 3 seconds after the shot for that reason.
     *
     * THE HOPPER IS LOADED THROUGH `capturePollen`, not by writing `r.hopper`, so the loaded state
     * is one the game can reach and the cap check inside it keeps the scene honest.
     */
    build: (seed): World => {
      const world = bbWorld(
        seed,
        [
          bbSetup(0, 'blue', { x: BB_HALF_X - 20, y: 0, headingDeg: 0 }, {
            ...loadout('dumper', 'front', null),
            intakeMount: 'back', // ...so the dumper's edge is clear, as a real dumper build is
          }),
        ],
        [],
      );
      emptyHoppers(world);
      loadHopper(world, world.robots[0], ['yellow', 'yellow', 'yellow', 'yellow']);
      return world;
    },
    // FIRE HELD FROM TICK 0, released at tick 30 so the second half is elements doing what
    // elements do rather than a launcher re-arming.
    script: (_world, tick) => ({ 0: bbCmd({ fire: tick < 30 }) }),
    stills: [0, 20, 45, 90, 240],
  },

  {
    id: 'turret-acquire',
    title: 'A turret ignores the nearer OPPONENT CELL and settles on its own open CELL',
    lane: 'robot',
    /**
     * WHERE A TURRET POINTS, as a picture — and WHICH TARGET IT CHOSE.
     *
     * A launcher aims at HIVE CELLS only (owner ruling 2026-09-12: nothing launched ever enters a
     * FLOWER, so a FLOWER is never a turret target). `bbPickTarget` then keeps a CELL only when it
     * is this robot's OWN alliance's and the robot stands on its OPEN side (`ScoreTarget.mouth`).
     *
     * The BLUE robot stands at (−45, 25), which makes the two filters visible:
     *  • RED's up-CELL (−12.75, −13.37) is NEARER — about 50 in against 59 — so nearest-by-
     *    distance picks the opponent's HIVE. It must not be aimed at: it scores nothing, and it
     *    also opens toward −y, away from this robot.
     *  • BLUE's own up-CELL (+12.75, +13.37) opens toward +y, and the robot is on that side.
     *
     * In the blue view world +x is screen DOWN and +y screen RIGHT. The own CELL lies almost
     * straight DOWN the screen from the robot (bearing −11°); the opponent's lies down and to the
     * LEFT (−50°); spawn aims at field centre (−29°), between the two. So the stills should show
     * the head swing a little to the RIGHT onto the own CELL while it elevates (the head visibly
     * FORESHORTENS as pitch climbs toward the lob). A head that ends pointing down-left is a
     * regressed target filter.
     *
     * The pose also keeps the footprint off red's HIVE frame bar (x = −25..−24, |y| <= 19.4): at
     * the (−30, 20) this scene used before, the robot spawned 5 in inside that bar and the solve
     * slid it out across the first second, so the stills were of a robot moving with no input.
     *
     * IT DOES NOT FIRE and its hopper is empty on purpose: this scene is about where the head
     * POINTS. `double-turret-feed` is the turret firing scene.
     */
    build: (seed): World => {
      const world = bbWorld(
        seed,
        [bbSetup(0, 'blue', { x: -45, y: 25, headingDeg: 0 }, { ...loadout('turret', 'center', null), intakeMount: 'front' })],
        [],
      );
      emptyHoppers(world);
      return world;
    },
    // NO COMMAND AT ALL. The turret tracks whether or not anything is pressed — it is not driver
    // control — so an empty script is the honest input here.
    script: () => ({ 0: bbCmd({}) }),
    stills: [0, 8, 20, 45, 120],
  },

  {
    id: 'boxtube-place',
    title: 'Two Box Tube robots drive square into a FLOWER, then press place POLLEN and later place NECTAR',
    lane: 'robot',
    /**
     * FLOWER SCORING IS PROXIMITY PLACEMENT, as a picture (owner ruling 2026-09-12).
     *
     * Two BLUE robots, each with a Box Tube at the FRONT, on the staged field:
     *  • robot 0 — a SINGLE turret holding its four preloaded POLLEN — drives +x into F3 (right
     *    wall, y = 24);
     *  • robot 1 — a DOUBLE turret holding POLLEN, NECTAR, POLLEN, NECTAR (two of its preloads
     *    traded for two of blue's human-player NECTAR, the other two set down behind it) — drives
     *    −y into F4 (audience wall, x = 24).
     *
     * Each starts 12 in short of flush on the FLOWER foot, square to it and centred on the ring.
     * `BB_PLACE_REACH` is derived so a footprint pressed flush on a foot puts the placement point
     * DEAD ON the ring, so the marker should LIGHT the moment the robot arrives (@60).
     *
     * Then, both robots on the same ticks: place POLLEN held for ten ticks from 70 (one press, one
     * element — the latch is an edge), and place NECTAR held for ten from 110. Robot 1 places one
     * of each; robot 0's NECTAR press does nothing, because a single turret's intake never took a
     * NECTAR. Watch the FLOWER stack badges and the held discs.
     */
    build: (seed): World => {
      const single = { ...loadout('turret', 'center', 'front') };
      const double = { ...loadout('twinturret', 'left', 'front', 'right') };
      const f3 = flowerById('F3');
      const f4 = flowerById('F4');
      const flush = (spec: Partial<RobotSpec>) => bbFootprint({ ...BB_DEFAULT_SPEC, ...spec }).front;
      const world = bbWorld(seed, [
        // F3's foot spans x ∈ [72 − 4.9, 72]; start 12 in short of flush, facing +x
        bbSetup(0, 'blue', { x: BB_HALF_X - 4.9 - flush(single) - 12, y: f3.y, headingDeg: 0 }, single),
        // F4's foot spans y ∈ [−72, −72 + 4.9]; start 12 in short of flush, facing −y
        bbSetup(1, 'blue', { x: f4.x, y: -BB_HALF_X + 4.9 + flush(double) + 12, headingDeg: -90 }, double),
      ]);
      const r1 = world.robots[1];
      restock(world, r1, ['yellow', 'blue', 'yellow', 'blue'], { x: r1.pos.x - 1.5, y: r1.pos.y + 14 });
      return world;
    },
    script: (world, tick) => {
      const out: Record<number, ReturnType<typeof bbCmd>> = {};
      for (const r of world.robots) {
        out[r.id] = bbCmd({
          driveY: tick < 60 ? bbThrottle(r.spec, 30) : 0,
          bbPlace: tick >= 70 && tick < 80,
          bbPlaceNectar: tick >= 110 && tick < 120,
        });
      }
      return out;
    },
    // @0 staged · @65 arrived, marker lit, nothing placed · @95 after place POLLEN · @135 after
    // place NECTAR
    stills: [0, 65, 95, 135],
  },

  {
    id: 'dumper-hive',
    title: 'A default dumper on its HIVE’s open side holds fire and puts its load in the up-CELL',
    lane: 'robot',
    /**
     * A DUMPER REACHES THE HIVE (owner ruling 2026-09-12).
     *
     * A BLUE dumper at the default 75° hood, firing over its FRONT edge, stands on the open (+y)
     * side of blue's up-CELL (+12.75, +13.37), facing −y, with its firing edge 30 in from the CELL
     * centre — inside the 23–71 in band that hood reaches. It holds POLLEN, NECTAR, POLLEN, NECTAR
     * (its own NECTAR, from blue's stock; the two spare preloads are set down behind it).
     *
     * Fire is held from tick 0. The dump is SOLVED per element (`bbDumpSolution`): each leaves
     * from its own point across the edge on its own converging arc, so the load should rise as a
     * line, draw together, and come DOWN into the CELL (≈ 34 ticks). The CELL already holds its 3
     * staged NECTAR, so this load tips it (`BB_TIP_POLLEN`), and the last still shows the swing.
     */
    build: (seed): World => {
      const spec = { ...loadout('dumper', 'front', null) };
      const hl = ({ ...BB_DEFAULT_SPEC, ...spec }.length ?? 15) / 2;
      const world = bbWorld(seed, [
        bbSetup(0, 'blue', { x: BB_HIVE_X, y: BB_HIVE_CELL_DY + 30 + hl, headingDeg: -90 }, spec),
      ]);
      const r = world.robots[0];
      restock(world, r, ['yellow', 'blue', 'yellow', 'blue'], { x: r.pos.x - 1.5, y: r.pos.y + 14 });
      return world;
    },
    script: (_world, tick) => ({ 0: bbCmd({ fire: tick < 30 }) }),
    // @0 loaded · @10 rising · @28 coming down over the CELL · @40 in the CELL · @150 settled
    stills: [0, 10, 28, 40, 150],
  },

  {
    id: 'double-turret-feed',
    title: 'A double turret holding POLLEN and NECTAR feeds its HIVE from two turrets',
    lane: 'robot',
    /**
     * TWO INDIVIDUAL TURRETS ON ONE FEED (owner ruling 2026-09-12).
     *
     * A BLUE double turret — POLLEN turret on the LEFT flank, NECTAR turret on the RIGHT — stands on
     * the open side of blue's up-CELL and holds POLLEN, NECTAR, POLLEN, NECTAR (the last is the
     * next to leave). Both turrets track the CELL from spawn with no input, so by @50 both heads
     * are slewed and elevated. Fire is held from tick 52: elements leave on the shared
     * `BB_FIRE_INTERVAL` clock, alternating NECTAR from the right-hand turret (alliance rim) and
     * POLLEN from the left, each on its own bearing — @58 shows the first NECTAR climbing and the
     * first POLLEN just leaving the other ring, @67 all four in the air.
     *
     * The first two arrive around @86, and with the CELL's 3 staged NECTAR that load TIPS it
     * (`BB_TIP_POLLEN`). A swinging CELL accepts nothing, so the last two arrive over a moving
     * opening and fly on to the tiles (@120). That is the game's rule, not a miss.
     */
    build: (seed): World => {
      const spec = { ...loadout('twinturret', 'left', null, 'right') };
      const world = bbWorld(seed, [bbSetup(0, 'blue', { x: -10, y: 50, headingDeg: 0 }, spec)]);
      const r = world.robots[0];
      restock(world, r, ['yellow', 'blue', 'yellow', 'blue'], { x: r.pos.x - 16, y: r.pos.y });
      return world;
    },
    script: (_world, tick) => ({ 0: bbCmd({ fire: tick >= 52 && tick < 100 }) }),
    stills: [0, 50, 58, 67, 86, 120],
  },

  ...ARCHETYPE_SHEETS,
];
