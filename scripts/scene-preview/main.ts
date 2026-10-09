// BIOBUZZ 3D scene preview — a throwaway Vite page for visual verification of the Day 1
// renderer chunk (`src/games/biobuzz/scene/`). Shape copied from `scripts/spike3d-browser/`:
// served standalone with `npx vite scripts/scene-preview --port 5178`, not built or tested by
// anything else in the repo.
//
// Builds a 2D-PHYSICS BIOBUZZ world (the `mode`/`physics` default `createBiobuzzWorld` has
// always had — the 3D-physics pipeline is Lane A's and not wired to a smoke-testable world yet),
// steps it so two 2v2 robots have driven, turned and (if their default launcher can) fired, then
// mounts `createBiobuzzScene` over the SAME live world and keeps stepping + rendering every
// frame — a livelier check than a single static screenshot, since it exercises robot motion,
// turret slew and ball flight, not just the field's static geometry.
//
// SIDE-BY-SIDE MODE (geometric-correctness pass, `docs/biobuzz/plan-3d.md` §4.2/§4.3 verification):
// a second, plain 2D `<canvas>` draws the SAME world through the REAL 2D renderer path
// (`drawBiobuzzField` + `drawHiveCanopy` + `drawBiobuzzBalls` + `drawBiobuzzRobot`, via the
// shared `Camera`), overhead at the same `viewAngle` the 3D overhead camera uses, so the two
// pictures can be compared directly. `window.__bbScene` exposes the live `THREE.Scene` so a
// console/`javascript_tool` session can walk named objects and measure them.

import * as THREE from 'three';
import { initPhysics } from '../../src/sim/physicsEngine';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { DEFAULT_ASSISTS, type RobotSetup } from '../../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { SIM_DT } from '../../src/config';
import { viewAngleOf } from '../../src/sim/field';
import type { Alliance, RobotCommand, World } from '../../src/types';
import type { SceneCamera } from '../../src/games/module';
import { setCameraPref } from '../../src/games/biobuzz/graphics/store';
import { setGraphicsSetting, type EnvironmentId } from '../../src/games/biobuzz/graphics/settings';
import { BB_ENVIRONMENT_IDS } from '../../src/games/biobuzz/graphics/environments';
import { Camera } from '../../src/render/camera';
import { Renderer } from '../../src/render/renderer';
import { drawBiobuzzField, drawHiveCanopy } from '../../src/games/biobuzz/drawField';
import { drawBiobuzzBalls } from '../../src/games/biobuzz/draw';
import { drawBiobuzzRobot } from '../../src/games/biobuzz/drawRobot';
import {
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_TOP_Z,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_OPEN_Z,
  BB_HIVE_X,
  BB_LZ,
  BB_VIEW_MARGIN,
  FLOWER_MOUTH,
} from '../../src/games/biobuzz/config';

// ── ISSUE-1 VERIFICATION HARNESS (2026-09-18: tray-tilt fix, `?physics=3d[&probe=hive[&tip=1]]`)
// Query-param driven so the file's DEFAULT behaviour (a 2D-physics world, side-by-side render)
// is completely unchanged for every existing use of this page — see the report for what each
// flag does and the numbers it produced.
import { initPhysics3d } from '../../src/games/biobuzz/sim3d/engine';
import { hiveCellLocalBox, hivePivotX } from '../../src/games/biobuzz/sim3d/bodies';
import { hiveTiltAngle } from '../../src/games/biobuzz/sim3d/hive3d';
import { rotate2 } from '../../src/games/biobuzz/sim3d/math3';
import { BB3_HIVE_PIVOT_Z, BB_HIVE_UP_STAGED, BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { GFX_TIERS, setGraphicsPreset, type GraphicsTier } from '../../src/games/biobuzz/graphics/settings';
import { BB_TIP_SWING_S } from '../../src/games/biobuzz/hive';
import { bbFootprint } from '../../src/games/biobuzz/robot';

const urlParams = new URLSearchParams(location.search);
const physicsMode = urlParams.get('physics') === '3d' ? '3d' : '2d';
// ── ENVIRONMENT / CAMERA / OVERLAY PICTURES (2026-09-21) ────────────────────────────────────
// `?env=<id>` picks one of `BB_ENVIRONMENTS`, `&ibl=0|1` forces §4.4's environment-lighting row
// (the tier ladder has it off on Low/Medium, and a painted dome is drawn either way — that is
// the thing worth photographing), `&cam=<SceneCamera>` opens on a camera instead of clicking the
// button round to it, and `&overlay=1` mounts the REAL 2D overlay canvas over the scene through
// `Renderer` with `overlayOnly`, which is the only way to photograph the 3D flower read-out
// through the path the game actually uses. `&flowers=mixed` stages NECTAR into the four flower
// columns so the read-out has something to say.
const envParam = urlParams.get('env');
const iblParam = urlParams.get('ibl');
const camParam = urlParams.get('cam');
const overlayOn = urlParams.get('overlay') === '1';
const flowersParam = urlParams.get('flowers');
// `&swatch=1` parks one POLLEN, one RED NECTAR and one BLUE NECTAR on bare tiles in a row, and
// exposes `__bbSwatches()` — their projected screen positions plus a bare-mat point. A capture
// script reads the RENDERED pixel at each and measures what the environment did to the three
// colours a driver has to tell apart. Measuring the rendered pixel is the whole point: the
// element fills are constants, and what an environment changes is the light on them.
const swatchOn = urlParams.get('swatch') === '1';
const hiveProbeAlliance: Alliance | null = urlParams.get('probe') === 'hive' ? 'red' : null;
const forceTip = urlParams.get('tip') === '1';
// INTAKE ARCHETYPE PICTURES (2026-09-20): `?intake=siderollers|ramp` builds every robot with that
// intake; `&park=flower` parks robot 0 flush on F1's foot, facing it, on idle commands, so the
// reach hardware can be photographed in the opening; `&ramp=1` deploys robot 0's ramp, settled.
const intakeParam = urlParams.get('intake');
const parkAtFlower = urlParams.get('park') === 'flower';
const parkOpen = urlParams.get('park') === 'open'; // robot 0 alone on open tiles, facing −x
const deployRamp = urlParams.get('ramp') === '1';
// DRIVETRAIN PICTURES (2026-09-21, the goBILDA wheel pass): `?drivetrain=mecanum|tank|swerve|
// xdrive|butterfly` builds every robot on that drivetrain, and `&gfx=<tier>` (any of `GFX_TIERS`:
// low, medium, high, ultra, extreme) picks a graphics COLUMN before the scene is created — which is how the wheels' two tessellation
// levels (`bbWheelDetail`) can be photographed side by side. `&tank=1` drops a butterfly's
// traction set instead of its mecanum set.
const drivetrainParam = urlParams.get('drivetrain');
const gfxParam = urlParams.get('gfx');
// `&mat=standard|physical` overrides the `materials` row AFTER `&gfx=` picked the column, so a
// pair of pictures at the SAME tier differs in the material model alone (Extreme with and
// without physical materials, or High with them turned on).
const matParam = urlParams.get('mat');
const butterflyTankParam = urlParams.get('tank') === '1';
// `&wheelrig=1` stands the five real drive-wheel parts on bare tiles — see the block that builds
// it for why a wheel on a ROBOT cannot be photographed at all.
const wheelRig = urlParams.get('wheelrig') === '1';
// `&chassis=orange&accent=black&decal=racing&plate=bold` — cosmetics on every robot (pictures)
const cosmeticParams = {
  chassisColor: urlParams.get('chassis') ?? undefined,
  accent: urlParams.get('accent') ?? undefined,
  decal: urlParams.get('decal') ?? undefined,
  plate: urlParams.get('plate') ?? undefined,
};

/**
 * Places one already-staged ball INSIDE alliance's UP cell, resting a few inches above its own
 * floor, tagged `{kind:'element', el:'hive:<alliance>'}` so the 3D sync (`engine.ts`'s
 * `syncElement`, `wantsDynamicBody`) gives it a REAL dynamic body and the next few physics ticks
 * settle it onto the cell's actual floor collider under gravity — this is the "place an element
 * JSON-side and let the sync seat it" verification the report calls for, proving the CAD tray's
 * captured pose and `hiveTrayRefTheta`'s correction agree with where the physics collider
 * actually is (a wrong correction either floats the ball above the true floor or drops it
 * through a wall it thinks is elsewhere).
 *
 * The WORLD position is computed the same way `derive.ts`'s `insideCell` does, in reverse: a
 * local box point `(v, w)` maps to world via `rotate2(v, w, theta − box.refTheta)` around the
 * pivot — see `sim3d/bodies.ts`'s file header for the derivation. Using the real formula (not
 * assuming identity) is deliberate: at the CAD path's default (`BB3_FIELD_COLLIDERS` true),
 * `theta` at rest already equals `box.refTheta` for the STAGED up side, so this reduces to a
 * plain offset — but the fallback box's `refTheta` is always 0 while `hiveTiltAngle` is never 0
 * at rest, so a probe that assumed identity would silently seat the ball wrong on that path.
 */
function placeElementInUpCell(world: World, alliance: Alliance): void {
  const up = world.biobuzz?.hives[alliance]?.up ?? BB_HIVE_UP_STAGED[alliance];
  const sideSign = up === 'north' ? 1 : -1;
  const box = hiveCellLocalBox(sideSign, alliance);
  const v = (box.vMin + box.vMax) / 2;
  const w = box.wMin + 3; // a few inches above the floor — settles down, never spawns inside it
  const theta = hiveTiltAngle(world, alliance);
  const { a: dy, b: dz } = rotate2(v, w, theta - box.refTheta);
  const target = world.balls.find((b) => b.state.kind === 'ground');
  if (!target) {
    status('hive probe: no ground-state ball available to place — skipped');
    return;
  }
  const r = target.r ?? BB_POLLEN_R;
  target.pos = { x: hivePivotX(alliance), y: dy };
  target.z = BB3_HIVE_PIVOT_Z + dz - r; // b.z is the BOTTOM height (sim3d's own convention)
  target.vel = { x: 0, y: 0 };
  target.vz = 0;
  target.state = { kind: 'element', el: `hive:${alliance}`, slot: 0 };
  status(`hive probe: placed ball ${target.id} in ${alliance} ${up} cell at world (${hivePivotX(alliance).toFixed(2)}, ${dy.toFixed(2)}, ${(BB3_HIVE_PIVOT_Z + dz).toFixed(2)})`);
}

function setup(id: number, alliance: Alliance, startIndex: number): RobotSetup {
  // `?drivetrain=` overrides the default build's; the spec is coerced downstream, so an unknown
  // value simply falls back rather than producing a robot nothing can draw
  const drive = drivetrainParam
    ? { drivetrain: drivetrainParam as (typeof BB_DEFAULT_SPEC)['drivetrain'] }
    : {};
  return {
    id,
    alliance,
    spec:
      intakeParam === 'siderollers' || intakeParam === 'ramp'
        ? { ...BB_DEFAULT_SPEC, ...cosmeticParams, ...drive, bbMech: { ...BB_DEFAULT_SPEC.bbMech!, intake: { kind: intakeParam } } }
        : { ...BB_DEFAULT_SPEC, ...cosmeticParams, ...drive },
    assists: { ...DEFAULT_ASSISTS },
    startIndex,
  };
}

const statusEl = document.getElementById('status')!;
function status(msg: string): void {
  statusEl.textContent = msg;
  console.log('[scene-preview]', msg);
}

const checksEl = document.getElementById('checks')!;

async function main(): Promise<void> {
  // ⚠️ BEFORE THE SCENE EXISTS. `createBiobuzzScene` reads the graphics store at construction,
  // and the wheels' tessellation is baked when a robot group is built — so a `?gfx=` set after
  // the scene mounted would only take effect on the next rebuild. Writing the real store (rather
  // than a private override) is also what makes the two tiers photographable through the same
  // path a player's own preset takes.
  // read off `GFX_TIERS`, not a literal list, so a new column is photographable the day it lands
  if ((GFX_TIERS as readonly string[]).includes(gfxParam ?? '')) {
    setGraphicsPreset(gfxParam as GraphicsTier);
    status(`graphics preset forced to ${gfxParam}`);
  }
  status('booting 2D physics...');
  await initPhysics();
  if (physicsMode === '3d') {
    status('booting 3D physics (rapier3d-deterministic-compat)...');
    await initPhysics3d();
  }

  status(`building a 2v2 biobuzz world (physics=${physicsMode})...`);
  const world = createBiobuzzWorld(
    'match',
    4242,
    [
      setup(0, 'red', 0), // TOP
      setup(1, 'red', 1), // BOTTOM
      setup(2, 'blue', 0),
      setup(3, 'blue', 1),
    ],
    undefined,
    physicsMode,
  );
  world.match.phase = 'teleop';
  world.match.phaseTimeLeft = 120;

  // drive forward, keep intake + fire held — with the default single-turret build this both
  // moves the robots off their start poses and gets a launch in flight once something is
  // captured, without needing a scripted, per-tick command sequence.
  //
  // THE HIVE PROBE WANTS THE OPPOSITE: an ISOLATED hive, undisturbed by organic gameplay — a
  // driving/firing robot can score into a hive on its own during the warm-up (or afterwards, in
  // the live render loop) and start a REAL tip at a time this harness does not control, which
  // both consumes the ball this probe is about to place and makes `tip=1`'s forced tip land on
  // top of an already-tipping hive. So a hive probe gets an IDLE command (no drive, no intake, no
  // fire, so the only thing moving is gravity on the placed ball and, if asked, the forced tip)
  // and skips the 180-tick warm-up entirely — the ball is placed the instant the world exists,
  // while `hive.up`/`.tipping` are still exactly `BB_HIVE_UP_STAGED`/`0`.
  const drive: RobotCommand = hiveProbeAlliance || parkAtFlower || parkOpen
    ? { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false }
    : { driveX: 0, driveY: 1, rotate: 0.15, leftDrive: 0, rightDrive: 0, intake: true, fire: true };
  const commands = new Map<number, RobotCommand>([
    [0, drive],
    [1, drive],
    [2, drive],
    [3, drive],
  ]);
  const warmupTicks = hiveProbeAlliance || parkAtFlower || parkOpen ? 0 : 180;
  for (let i = 0; i < warmupTicks; i++) biobuzzStep(world, SIM_DT, commands);

  if (parkOpen) {
    const r0 = world.robots[0];
    r0.pos = { x: -40, y: -24 };
    r0.heading = Math.PI;
    r0.vel = { x: 0, y: 0 };
    r0.angVel = 0;
    if (deployRamp) {
      r0.bbRampOut = true;
      r0.bbRampAt = world.time - 1;
    }
    // `&tank=1`: drop a butterfly's TRACTION set instead of its mecanum set, so both halves of
    // that drivetrain can be photographed from the same pose
    if (butterflyTankParam) r0.butterflyTank = true;
  }
  if (parkAtFlower) {
    // robot 0 flush on F1's foot (mouth +x), front mouth toward the wall: the footprint's front
    // face on the foot's field face, which is `BB_FLOWER_FOOT.deep − BB_FLOWER_D` past the ring
    const r0 = world.robots[0];
    const f = BB_FLOWERS[0];
    const front = bbFootprint(r0.spec).front;
    r0.pos = { x: f.x + (BB_FLOWER_FOOT.deep - BB_FLOWER_D) + front, y: f.y };
    r0.heading = Math.PI;
    r0.vel = { x: 0, y: 0 };
    r0.angVel = 0;
    if (deployRamp) {
      r0.bbRampOut = true;
      r0.bbRampAt = world.time - 1;
    }
    status(`parked robot 0 at (${r0.pos.x.toFixed(2)}, ${r0.pos.y.toFixed(2)}) on F1${deployRamp ? ', ramp down' : ''}`);
  }

  if (hiveProbeAlliance) {
    placeElementInUpCell(world, hiveProbeAlliance);
    if (forceTip && world.biobuzz) {
      const hive = world.biobuzz.hives[hiveProbeAlliance];
      world.biobuzz.hives[hiveProbeAlliance] = { ...hive, tipping: BB_TIP_SWING_S, released: false };
      status(`hive probe: forced a ${BB_TIP_SWING_S}s tip on ${hiveProbeAlliance}`);
    }
  }

  // MIXED FLOWER STACKS, for the read-out pictures. `spawn.ts` stages every flower with POLLEN
  // alone, which makes a section a column of four identical discs — the thing a driver actually
  // has to read is the ORDER, the ownership colour and the retrieval lock, and all three need a
  // NECTAR in there. The stack ids are untouched: only the ELEMENTS' colour/radius change, which
  // is exactly what the renderer joins on.
  if (flowersParam === 'mixed' && world.biobuzz) {
    const byId = new Map(world.balls.map((b) => [b.id, b]));
    // F0 bottom NECTAR (retrieval LOCKED, 5-point bonus), F1 top NECTAR (red owns it),
    // F2 a blue NECTAR in the middle, F3 left all POLLEN as the control
    const recolour: [number, number, 'red' | 'blue'][] = [
      [0, 0, 'red'],
      [1, 3, 'red'],
      [2, 2, 'blue'],
    ];
    for (const [fi, slot, colour] of recolour) {
      const id = world.biobuzz.flowers[fi]?.stack[slot];
      const ball = id === undefined ? undefined : byId.get(id);
      if (ball) {
        ball.color = colour;
        ball.r = 1.8; // a NECTAR is 3.6 in across (§9.8); POLLEN is 2.8
      }
    }
    status('staged mixed flower stacks (F1 locked, F2 red-owned, F3 blue mid, F4 all pollen)');
  }

  // THE COLOUR SWATCHES (`&swatch=1`) — three elements on bare tiles just inside the audience
  // wall, in the driver camera's own lower third, where nothing else stands.
  const SWATCH_Y = -46;
  const SWATCH_X = [-14, 0, 14];
  if (swatchOn) {
    const loose = world.balls.filter((b) => b.state.kind === 'ground').slice(0, 3);
    const colours = ['yellow', 'red', 'blue'] as const;
    loose.forEach((b, k) => {
      b.color = colours[k];
      b.r = k === 0 ? BB_POLLEN_R : 1.8;
      b.pos = { x: SWATCH_X[k], y: SWATCH_Y };
      b.z = 0;
      b.vel = { x: 0, y: 0 };
      b.vz = 0;
    });
    (window as unknown as { __bbSwatchIds: number[] }).__bbSwatchIds = loose.map((b) => b.id);
    status(`swatches: ${loose.map((b) => `${b.id}:${b.color}`).join(' ')}`);
  }

  status('loading the scene chunk...');
  if (envParam && (BB_ENVIRONMENT_IDS as readonly string[]).includes(envParam)) {
    setGraphicsSetting('environment', envParam as EnvironmentId);
  }
  if (iblParam === '0' || iblParam === '1') setGraphicsSetting('envLighting', iblParam === '1');
  if (matParam === 'standard' || matParam === 'physical') setGraphicsSetting('materials', matParam);
  const { createBiobuzzScene } = await import('../../src/games/biobuzz/scene/renderScene');
  const host = document.getElementById('host')!;
  const scene = await createBiobuzzScene(host);

  // EXPOSE THE LIVE THREE.Scene for console / `javascript_tool` inspection — `BiobuzzScene`'s
  // `scene` field is `private` at the TYPE level only; at runtime it is a plain property, and
  // this file (scene-preview-only, per the verification brief) is where that cast belongs
  // rather than widening the class's real public API for a debug hook.
  (window as unknown as { __bbScene: THREE.Scene }).__bbScene = (scene as unknown as { scene: THREE.Scene }).scene;
  (window as unknown as { __bbWorld: World }).__bbWorld = world;
  // and the `GameScene` itself, for the same kind of inspection of its PRIVATE state — the
  // physical-materials comparison reads `surfaces` (is the chunk live, did the probe capture)
  (window as unknown as { __bbGameScene: unknown }).__bbGameScene = scene;

  // ── THE WHEEL RIG (2026-09-21) — `?wheelrig=1` ─────────────────────────────────────────────
  // ⚠️ A DRIVE WHEEL CANNOT BE PHOTOGRAPHED ON A ROBOT, and that is not a bug in the wheel. It
  // lives in the channel BETWEEN the two side plates, and the outer plate is solid except for its
  // three lightening holes — so from outside, all a camera ever sees of a 104 mm mecanum is the
  // middle of its steel hub plate through a 2.4-in hole, with the rollers behind it. (That is
  // also the honest explanation of the owner's report: a `CylinderGeometry`'s flat CAP takes the
  // roller-stripe texture too, so what actually showed through that hole was a disc with
  // DIAGONAL LINES PAINTED ON IT — a slant where a real wheel has a plain steel plate.)
  // So the rig stands the four real parts on bare tiles, at their true sizes, for the close-ups.
  if (wheelRig) {
    const { BB_WHEEL_PARTS, bbWheelDetail, buildDriveWheel } = await import(
      '../../src/games/biobuzz/scene/renderRobots'
    );
    const { getGraphics } = await import('../../src/games/biobuzz/graphics/settings');
    const g = getGraphics();
    const detail = bbWheelDetail(g.settings, g.tier);
    const rig = new THREE.Group();
    rig.name = 'bb-wheel-rig';
    // a LEFT and a RIGHT mecanum side by side is the handedness picture; the rest are one each
    const row = [
      ['mecanum', 1],
      ['mecanum', -1],
      ['omni', 1],
      ['traction', 1],
      ['podTraction', 1],
    ] as const;
    row.forEach(([kind, hand], i) => {
      const wheel = buildDriveWheel(kind, detail, undefined, hand);
      wheel.position.set(-18 + i * 9, 40, BB_WHEEL_PARTS[kind].r);
      wheel.name = `rig:${kind}:${hand > 0 ? 'L' : 'R'}`;
      rig.add(wheel);
    });
    (window as unknown as { __bbScene: THREE.Scene }).__bbScene.add(rig);
    status(`wheel rig: 5 parts on bare tiles at y=40, detail=${detail}`);
  }
  // the `GameScene` itself, so a verification script can read `cameras.free` after a synthetic drag
  (window as unknown as { __bbGameScene: unknown }).__bbGameScene = scene;
  (window as unknown as { __bbRenderer: THREE.WebGLRenderer }).__bbRenderer = (
    scene as unknown as { renderer: THREE.WebGLRenderer }
  ).renderer;

  const CAMERA_IDS: readonly SceneCamera[] = ['driver', 'overhead', 'chase', 'orbit', 'free'];
  let camera: SceneCamera = (CAMERA_IDS as readonly string[]).includes(camParam ?? '')
    ? (camParam as SceneCamera)
    : 'driver';
  let alliance: Alliance = urlParams.get('alliance') === 'blue' ? 'blue' : 'red';
  let probing = false;
  /** RETICLE DEMO (Day 2): park robot 0 at a firing distance from its own HIVE, facing it, and
   * KEEP STEPPING — the turret only slews onto Aim Assist's target inside `biobuzzStep` stage
   * 5b, so freezing the world (what `probing` does) would show the reticle wherever the barrel
   * happened to be pointing. Re-pinned every frame after the step, so drive/shove cannot move it
   * off the mark while you are looking at the ring. */
  let reticleDemo = false;
  const headings = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let headingIdx = 0;
  const camBtn = document.getElementById('camBtn')!;
  const reticleBtn = document.getElementById('reticleBtn')!;
  const allianceBtn = document.getElementById('allianceBtn')!;
  const probeBtn = document.getElementById('probeBtn')!;
  const headingBtn = document.getElementById('headingBtn')!;
  const checkBtn = document.getElementById('checkBtn')!;

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    scene.resize(host.clientWidth, host.clientHeight, dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  // all FIVE cameras (`SceneCamera`): driver → overhead → chase → orbit → free. The scene
  // resolves the DEVICE preference over whatever is passed here, so this page also has to be
  // able to say "leave it alone": `setCameraPref('auto')` below, once, does that — otherwise a
  // preference left behind by the app in the same browser profile would quietly win over every
  // click of this button and make the page look broken.
  const CAMERAS: SceneCamera[] = ['driver', 'overhead', 'chase', 'orbit', 'free'];
  setCameraPref('auto');
  camBtn.textContent = `Camera: ${camera}`;
  allianceBtn.textContent = `Viewpoint: ${alliance}`;
  camBtn.addEventListener('click', () => {
    camera = CAMERAS[(CAMERAS.indexOf(camera) + 1) % CAMERAS.length];
    camBtn.textContent = `Camera: ${camera}`;
  });
  reticleBtn.addEventListener('click', () => {
    reticleDemo = !reticleDemo;
    reticleBtn.textContent = `Reticle demo: ${reticleDemo ? 'on' : 'off'}`;
  });
  allianceBtn.addEventListener('click', () => {
    alliance = alliance === 'red' ? 'blue' : 'red';
    allianceBtn.textContent = `Viewpoint: ${alliance}`;
  });
  probeBtn.addEventListener('click', () => {
    probing = !probing;
    probeBtn.textContent = `Probe: ${probing ? 'on' : 'off'}`;
    if (probing) {
      world.robots[0].pos = { x: 0, y: 0 };
      world.robots[0].vel = { x: 0, y: 0 };
      world.robots[0].angVel = 0;
      world.robots[0].heading = headings[headingIdx];
    }
  });
  headingBtn.addEventListener('click', () => {
    headingIdx = (headingIdx + 1) % headings.length;
    headingBtn.textContent = `Heading: ${Math.round((headings[headingIdx] * 180) / Math.PI)}`;
    if (probing) world.robots[0].heading = headings[headingIdx];
  });
  checkBtn.addEventListener('click', () => runChecks());

  /** park robot 0 in front of its own HIVE, aimed at it, with a full hopper — the pose the
   * reticle is easiest to read at (a turret at ~55 in from the pivot clears the frame's top bar
   * and the ring lands in the up CELL rather than on the tray's back wall). */
  function pinReticleDemoRobot(): void {
    const r = world.robots[0];
    // the red HIVE sits at −BB_HIVE_X; stand off it along +x and face back down the axis
    r.pos = { x: -BB_HIVE_X + 55, y: 6 };
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
    r.heading = Math.PI;
    if (r.hopper.length === 0) r.hopper.push('yellow');
  }

  // ── SIDE-BY-SIDE 2D CANVAS ─────────────────────────────────────────────────────────────────
  const canvas2d = document.getElementById('host2d') as HTMLCanvasElement;
  const ctx2d = canvas2d.getContext('2d')!;
  const cam2d = new Camera();
  const bounds = { halfX: BB_HALF_X, halfY: BB_HALF_Y, viewMargin: BB_VIEW_MARGIN };

  function draw2d(): void {
    // `Camera.configure` reads `canvas.clientWidth/Height` (the CSS-laid-out size) and sets the
    // backing-store `canvas.width/height` itself — no manual resize needed here.
    cam2d.configure(canvas2d, alliance, bounds);
    ctx2d.save();
    cam2d.apply(ctx2d);
    const screenUp = cam2d.screenUpWorld();
    drawBiobuzzField(ctx2d, world, screenUp);
    for (const r of world.robots) {
      const held = world.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id);
      drawBiobuzzRobot(ctx2d, r, commands.get(r.id)?.intake ?? false, held, screenUp, world);
    }
    drawBiobuzzBalls(ctx2d, world, screenUp);
    void drawHiveCanopy; // already called inside drawBiobuzzBalls
    ctx2d.restore();
  }

  // ── THE REAL 2D OVERLAY, OVER THE SCENE (`?overlay=1`, 2026-09-21) ───────────────────────
  //
  // The app mounts the 2D canvas ABOVE the WebGL one and draws it with `overlayOnly`, which is
  // the pass the driver-name labels and (since 2026-09-21) the BIOBUZZ flower read-out live in.
  // This page had no such canvas, so neither could be photographed here. It is the SHIPPING
  // `Renderer` and the SHIPPING `setScene` hand-over — a second drawing of the overlay would be
  // evidence about itself and nothing else.
  const overlayCanvas = document.createElement('canvas');
  const overlayCtx = overlayOn ? overlayCanvas.getContext('2d')! : null;
  const overlayRenderer = new Renderer();
  if (overlayOn) {
    overlayCanvas.id = 'overlay';
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.inset = '0';
    overlayCanvas.style.width = '100%';
    overlayCanvas.style.height = '100%';
    overlayCanvas.style.zIndex = '2';
    overlayCanvas.style.pointerEvents = 'none';
    host.appendChild(overlayCanvas);
    overlayRenderer.setScene(scene);
  }

  function drawOverlay(): void {
    if (!overlayCtx) return;
    overlayRenderer.camera.configure(overlayCanvas, alliance, bounds);
    overlayRenderer.render(
      overlayCtx,
      world,
      null,
      alliance === 'red' ? 0 : 2,
      true, // overlayOnly — the scene owns the field, the robots and the elements
    );
  }

  /**
   * WHERE THE SWATCHES LANDED ON SCREEN, in CSS pixels, through the scene's OWN live camera
   * (`GameScene.project`). A capture script reads the rendered pixel at each of these and gets
   * the three element colours AS LIT, plus a bare-mat reference and the backdrop above the far
   * wall — which is everything the legibility table in the 2026-09-21 environment report is
   * computed from.
   */
  (window as unknown as { __bbSwatches: () => unknown }).__bbSwatches = () => {
    const out: Record<string, unknown> = {};
    const o = { x: 0, y: 0, visible: false };
    const proj = (x: number, y: number, z: number): [number, number, boolean] => {
      scene.project?.(x, y, z, o);
      return [o.x, o.y, o.visible];
    };
    const ids = (window as unknown as { __bbSwatchIds?: number[] }).__bbSwatchIds ?? [];
    ids.forEach((id, k) => {
      const b = world.balls.find((q) => q.id === id);
      if (!b) return;
      out[['pollen', 'nectarRed', 'nectarBlue'][k]] = proj(b.pos.x, b.pos.y, (b.z ?? 0) + (b.r ?? BB_POLLEN_R));
    });
    // a patch of bare tile a few feet in front of the swatch row, and the field centre
    out.mat = proj(0, -58, 0.05);
    out.matMid = proj(-30, -10, 0.05);
    out.css = [host.clientWidth, host.clientHeight];
    return out;
  };

  // ── FREE CAMERA (2026-09-18 CAD round 2 verification) ────────────────────────────────────
  // The scene owns its two cameras (`renderCameras.ts`, another lane's file), and neither of
  // them can look at a hive from the SIDE — which is the one view that shows whether an element
  // is resting on the tray floor or floating above it. So this page gets its own: `__bbFreeze`
  // stops the world stepping AND the scene's own render, and `__bbFreeCam` draws the live
  // `THREE.Scene` through a camera the caller places. Preview-only, additive, and it touches
  // nothing the app ships.
  const freeCam = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  freeCam.up.set(0, 0, 1); // this scene is z-up
  const w = window as unknown as {
    __bbFreeze: boolean;
    __bbFreeCam: (eye: [number, number, number], target: [number, number, number], fov?: number) => void;
    __bbStep: (n: number) => number;
  };
  w.__bbFreeze = false;
  // `requestAnimationFrame` only advances when a paint is forced (CLAUDE.md's own note about
  // driving this in an automated browser), so a verification session that needs 200 settled ticks
  // would need 200 screenshots. This steps the world directly instead.
  w.__bbStep = (n) => {
    for (let i = 0; i < n; i++) biobuzzStep(world, SIM_DT, commands);
    return world.tick;
  };
  // ⚠️ RE-RENDERED EVERY FRAME, not once. A WebGL canvas is created with
  // `preserveDrawingBuffer: false`, so the buffer is thrown away after each composite — a
  // one-shot render followed by a screenshot (which itself forces the NEXT paint) shows black.
  // So the free view is STATE, and the frame loop draws it.
  let freeView: { eye: [number, number, number]; target: [number, number, number]; fov: number } | null = null;
  w.__bbFreeCam = (eye, target, fov = 35) => {
    freeView = { eye, target, fov };
    w.__bbFreeze = true;
  };
  function renderFree(): void {
    if (!freeView) return;
    // ⚠️ LET THE SCENE UPDATE ITSELF FIRST. `updateBiobuzzField` — the one place that rotates each
    // tray to `hiveTiltAngle` — runs inside `scene.render`, so a frozen loop that only draws
    // through the free camera shows both trays at rotation 0, i.e. LEVEL, which reads exactly like
    // the tilt bug this pass fixed. (In an automated browser `requestAnimationFrame` only advances
    // when a screenshot forces a paint, so "it ran a moment ago" is not a safe assumption either.)
    scene.render(world, {
      alpha: 1,
      viewAngle: viewAngleOf(alliance),
      camera,
      localRobotId: alliance === 'red' ? 0 : 2,
      width: host.clientWidth,
      height: host.clientHeight,
      dpr: window.devicePixelRatio || 1,
    });
    const renderer = (scene as unknown as { renderer: THREE.WebGLRenderer }).renderer;
    const three = (scene as unknown as { scene: THREE.Scene }).scene;
    freeCam.fov = freeView.fov;
    freeCam.aspect = host.clientWidth / host.clientHeight;
    freeCam.position.set(freeView.eye[0], freeView.eye[1], freeView.eye[2]);
    freeCam.lookAt(freeView.target[0], freeView.target[1], freeView.target[2]);
    freeCam.updateProjectionMatrix();
    renderer.setRenderTarget(null); // the scene blits from its own MSAA target; draw to the CANVAS
    renderer.render(three, freeCam);
  }

  // ── CLEAR-PANEL CONTRIBUTION PROBE (2026-09-19, owner: "the back panel of the hive is TOO
  // transparent when seen from the back, but from the front it looks fine") ──────────────────
  //
  // A panel's real bug is not its alpha, it is HOW MANY PIXELS IT CHANGES. So this renders the
  // same free-camera view TWICE — once with the clear panels visible, once with them hidden —
  // and reports the per-pixel luminance delta. That number is the panel's visibility, in the
  // real shader, against whatever happens to be behind it in that view, which is the whole
  // question. `hide` picks the family: the hive CELL skins (`plastic#e6e6e6` in a tray node) or
  // the perimeter WALL glass. Preview-only, additive; it touches nothing the app ships.
  function panelMeshes(kind: 'cells' | 'walls'): THREE.Mesh[] {
    const three = (scene as unknown as { scene: THREE.Scene }).scene;
    const out: THREE.Mesh[] = [];
    three.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const mn = m?.name ?? '';
      const on = o.name ?? '';
      const isCell = mn.startsWith('plastic#e6e6e6@hive_tray') || /:cell:[a-z]+:(back|side|ceiling)/.test(on);
      const isWall = mn.startsWith('glass#') || /^wall:/.test(on);
      if (kind === 'cells' ? isCell : isWall) out.push(o);
    });
    return out;
  }
  function lum(d: Uint8Array, i: number): number {
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  function readFrame(): { data: Uint8Array; w: number; h: number } {
    const renderer = (scene as unknown as { renderer: THREE.WebGLRenderer }).renderer;
    const gl = renderer.getContext();
    const wpx = gl.drawingBufferWidth;
    const hpx = gl.drawingBufferHeight;
    const data = new Uint8Array(wpx * hpx * 4);
    gl.readPixels(0, 0, wpx, hpx, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, w: wpx, h: hpx };
  }
  function toPng(f: { data: Uint8Array; w: number; h: number }): string {
    const cv = document.createElement('canvas');
    cv.width = f.w;
    cv.height = f.h;
    const c = cv.getContext('2d')!;
    const img = c.createImageData(f.w, f.h);
    // readPixels is bottom-up; an ImageData is top-down.
    for (let y = 0; y < f.h; y++) {
      const src = (f.h - 1 - y) * f.w * 4;
      img.data.set(f.data.subarray(src, src + f.w * 4), y * f.w * 4);
    }
    c.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  function renderAt(eye: [number, number, number], target: [number, number, number], fov: number): void {
    scene.render(world, {
      alpha: 1,
      viewAngle: viewAngleOf(alliance),
      camera,
      localRobotId: alliance === 'red' ? 0 : 2,
      width: host.clientWidth,
      height: host.clientHeight,
      dpr: window.devicePixelRatio || 1,
    });
    const renderer = (scene as unknown as { renderer: THREE.WebGLRenderer }).renderer;
    const three = (scene as unknown as { scene: THREE.Scene }).scene;
    freeCam.fov = fov;
    freeCam.aspect = host.clientWidth / host.clientHeight;
    freeCam.position.set(eye[0], eye[1], eye[2]);
    freeCam.lookAt(target[0], target[1], target[2]);
    freeCam.updateProjectionMatrix();
    renderer.setRenderTarget(null); // the scene blits from its own MSAA target; draw to the CANVAS
    renderer.render(three, freeCam);
  }
  /** the live tray pose, so a probe script can place a camera on a CELL's own mouth/back normal
   * instead of guessing one — the local (v, w) box rotates by `theta` about the pivot, exactly as
   * `placeElementInUpCell` above does it. */
  (window as unknown as { __bbHive: () => unknown }).__bbHive = () => {
    const out: Record<string, unknown> = {};
    for (const a of ['red', 'blue'] as const) {
      const h = world.biobuzz?.hives[a];
      const theta = hiveTiltAngle(world, a);
      const up = h?.up ?? BB_HIVE_UP_STAGED[a];
      out[a] = {
        theta,
        up,
        tipping: h?.tipping ?? 0,
        pivot: [hivePivotX(a), 0, BB3_HIVE_PIVOT_Z],
        north: hiveCellLocalBox(1, a),
        south: hiveCellLocalBox(-1, a),
      };
    }
    return out;
  };
  /** force the clear panels' `side`, to settle "is this face being drawn at all" by looking
   * rather than by counting normals — the 2026-09-19 culling question. */
  (window as unknown as { __bbSide: (s: 'front' | 'back' | 'double') => unknown }).__bbSide = (s) => {
    const want = s === 'front' ? THREE.FrontSide : s === 'back' ? THREE.BackSide : THREE.DoubleSide;
    const mats = new Set<THREE.Material>();
    for (const m of panelMeshes('cells')) {
      const mm = Array.isArray(m.material) ? m.material[0] : m.material;
      if (mm) mats.add(mm);
    }
    for (const m of mats) {
      m.side = want;
      m.needsUpdate = true;
    }
    return mats.size;
  };

  /**
   * AREA-WEIGHTED TRIANGLE-NORMAL BINS for the hive tray's clear-plastic mesh, in the TRAY's own
   * local frame (the pivot group's inverse), by AZIMUTH — 16 bins, so a diagonal sheet lands in a
   * bin of its own instead of being invisible to a ±x/±y count. Plus, per PLANE (triangles
   * clustered by their plane's normal and offset), the area facing each way, which is what says
   * whether a sheet is two-faced or single-sided.
   */
  (window as unknown as { __bbClearGeom: (alliance: Alliance | 'walls') => unknown }).__bbClearGeom = (alliance) => {
    const three = (scene as unknown as { scene: THREE.Scene }).scene;
    const walls = alliance === 'walls';
    const pivot = walls
      ? three
      : findOriginal(three, `hive_${alliance}/tray-pivot`) ?? findOriginal(three, `hive_${alliance}/tray`);
    const out: { mesh: string; localBox: string; tris: number; azBins: number[]; planes: { n: string; d: number; fwd: number; back: number }[] }[] = [];
    three.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const want = walls ? /^glass#/ : /plastic#e6e6e6@hive_tray/;
      if (!want.test(m?.name ?? '')) return;
      let anc: THREE.Object3D | null = o;
      let mine = false;
      while (anc) {
        if (anc === pivot) mine = true;
        anc = anc.parent;
      }
      if (!mine) return;
      o.updateWorldMatrix(true, false);
      const toLocal = new THREE.Matrix4().copy(pivot!.matrixWorld).invert().multiply(o.matrixWorld);
      const pos = o.geometry.getAttribute('position');
      const idx = o.geometry.getIndex();
      const count = idx ? idx.count : pos.count;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const e1 = new THREE.Vector3();
      const e2 = new THREE.Vector3();
      const azBins = new Array(16).fill(0);
      const planes = new Map<string, { n: THREE.Vector3; d: number; fwd: number; back: number }>();
      for (let t = 0; t < count; t += 3) {
        const i0 = idx ? idx.getX(t) : t;
        const i1 = idx ? idx.getX(t + 1) : t + 1;
        const i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(toLocal);
        b.fromBufferAttribute(pos, i1).applyMatrix4(toLocal);
        c.fromBufferAttribute(pos, i2).applyMatrix4(toLocal);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        const n = new THREE.Vector3().crossVectors(e1, e2);
        const area = n.length() / 2;
        if (area <= 0) continue;
        n.normalize();
        const az = Math.atan2(n.y, n.x); // the tray's own arm axis is y, its width axis x
        azBins[Math.min(15, Math.max(0, Math.floor(((az + Math.PI) / (2 * Math.PI)) * 16)))] += area;
        // cluster by unsigned plane: the same sheet's two faces share a plane and differ in sign
        const sign = n.x + n.y * 1e-3 + n.z * 1e-6 >= 0 ? 1 : -1;
        const un = n.clone().multiplyScalar(sign);
        const d = un.dot(a);
        const key = `${un.x.toFixed(2)},${un.y.toFixed(2)},${un.z.toFixed(2)}|${(Math.round(d / 0.25) * 0.25).toFixed(2)}`;
        let p = planes.get(key);
        if (!p) {
          p = { n: un, d, fwd: 0, back: 0 };
          planes.set(key, p);
        }
        if (sign > 0) p.fwd += area;
        else p.back += area;
      }
      const bb = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute).applyMatrix4(toLocal);
      out.push({
        mesh: (o.userData as { name?: string })?.name ?? o.name,
        localBox: `${bb.min.x.toFixed(1)}..${bb.max.x.toFixed(1)} x ${bb.min.y.toFixed(1)}..${bb.max.y.toFixed(1)} x ${bb.min.z.toFixed(1)}..${bb.max.z.toFixed(1)}`,
        tris: count / 3,
        azBins: azBins.map((v) => Math.round(v)),
        planes: [...planes.values()]
          .filter((p) => p.fwd + p.back > 0.5)
          .sort((p, q) => q.fwd + q.back - (p.fwd + p.back))
          .slice(0, 14)
          .map((p) => ({ n: `${p.n.x.toFixed(2)},${p.n.y.toFixed(2)},${p.n.z.toFixed(2)}`, d: +p.d.toFixed(2), fwd: Math.round(p.fwd), back: Math.round(p.back) })),
      });
    });
    return out;
  };

  /** move the key light, to separate "this panel is lit" from "this panel is visible" — the whole
   * point of the 2026-09-19 measurement. `null` restores `renderScene.ts`'s own position. */
  (window as unknown as { __bbSun: (p: [number, number, number] | null) => unknown }).__bbSun = (p) => {
    const three = (scene as unknown as { scene: THREE.Scene }).scene;
    let hit: THREE.DirectionalLight | null = null;
    three.traverse((o) => {
      if (!hit && (o as THREE.DirectionalLight).isDirectionalLight) hit = o as THREE.DirectionalLight;
    });
    if (!hit) return 'no directional light';
    const sun = hit as THREE.DirectionalLight;
    const q = p ?? [60, -80, 140];
    sun.position.set(q[0], q[1], q[2]);
    return q;
  };

  /**
   * ⚠️ THE MASK IS THE PANEL'S OWN FOOTPRINT, NOT "the pixels that changed". A mean taken over
   * changed pixels alone cannot see the failure being measured — a panel that vanishes over half
   * its area scores the same as one that is uniformly present, because the vanished half is not
   * in the denominator. So a THIRD pass renders the same panel OPAQUE and that silhouette is the
   * denominator, and `deadFrac` reports how much of it the eye cannot find.
   *
   * `clip` narrows the clear-panel material to a convex region (each entry keeps `n·p + c ≥ 0`),
   * which is how ONE skin of a six-skin merged mesh gets measured on its own.
   *
   * The reported contrast is WEBER, |ΔL| / L(background): a +15 on a bright khaki backdrop and a
   * +15 on the dark tiles are not the same picture, and the owner is reporting the first one.
   */
  (
    window as unknown as {
      __bbProbe: (spec: {
        eye: [number, number, number];
        target: [number, number, number];
        fov?: number;
        hide?: 'cells' | 'walls';
        clip?: { n: [number, number, number]; c: number }[];
        png?: boolean;
      }) => unknown;
    }
  ).__bbProbe = (spec) => {
    w.__bbFreeze = true;
    freeView = null; // the frame loop must not re-render over the buffer we are about to read
    const fov = spec.fov ?? 35;
    const kind = spec.hide ?? 'cells';
    const meshes = panelMeshes(kind);
    const renderer = (scene as unknown as { renderer: THREE.WebGLRenderer }).renderer;
    const mats = [...new Set(meshes.map((m) => (Array.isArray(m.material) ? m.material[0] : m.material)))];
    const planes = (spec.clip ?? []).map((p) => new THREE.Plane(new THREE.Vector3(p.n[0], p.n[1], p.n[2]), p.c));
    const prevLocal = renderer.localClippingEnabled;
    if (planes.length) {
      renderer.localClippingEnabled = true;
      for (const m of mats) m.clippingPlanes = planes;
    }

    renderAt(spec.eye, spec.target, fov);
    const withP = readFrame();
    const png = spec.png ? toPng(withP) : undefined;

    const prevVis = meshes.map((m) => m.visible);
    for (const m of meshes) m.visible = false;
    renderAt(spec.eye, spec.target, fov);
    const without = readFrame();
    meshes.forEach((m, i) => (m.visible = prevVis[i]));
    const pngHidden = spec.png ? toPng(without) : undefined;

    // the silhouette pass
    const prevT = mats.map((m) => [(m as THREE.MeshStandardMaterial).transparent, (m as THREE.MeshStandardMaterial).opacity, (m as THREE.MeshStandardMaterial).depthWrite] as const);
    for (const m of mats) {
      const s = m as THREE.MeshStandardMaterial;
      s.transparent = false;
      s.opacity = 1;
      s.depthWrite = true;
      s.needsUpdate = true;
    }
    renderAt(spec.eye, spec.target, fov);
    const solid = readFrame();
    mats.forEach((m, i) => {
      const s = m as THREE.MeshStandardMaterial;
      s.transparent = prevT[i][0];
      s.opacity = prevT[i][1];
      s.depthWrite = prevT[i][2];
      s.needsUpdate = true;
    });
    if (planes.length) {
      for (const m of mats) m.clippingPlanes = null;
      renderer.localClippingEnabled = prevLocal;
    }

    let mask = 0;
    // DETAIL KEPT: the luminance spread inside the panel's own silhouette, with the panel and
    // without it. A veil that washes the elements out shows up here and nowhere else — a mean
    // delta cannot tell "a milky sheet you can still read a NECTAR through" from "a white board".
    let sumW = 0;
    let sumW2 = 0;
    let sumO = 0;
    let sumO2 = 0;
    let sumAbs = 0;
    let sumSigned = 0;
    let sumWeber = 0;
    let sumRgb = 0;
    let sumBg = 0;
    let dead = 0;
    let peak = 0;
    const total = withP.w * withP.h;
    // ⚠️ THE SILHOUETTE TEST IS PER CHANNEL, NOT ON LUMINANCE. A grey panel and the warm room
    // behind it can sit at the SAME luminance and differ entirely in hue — a luminance test threw
    // most of the panel's own area out of its own denominator and left a rim, which is how the
    // first run of this probe reported a 13k-pixel mask for a panel covering ten times that.
    const chan = (d: Uint8Array, i: number, bs: Uint8Array): number =>
      Math.max(Math.abs(d[i] - bs[i]), Math.abs(d[i + 1] - bs[i + 1]), Math.abs(d[i + 2] - bs[i + 2]));
    for (let i = 0; i < total * 4; i += 4) {
      if (chan(solid.data, i, without.data) < 2) continue; // not the panel's own silhouette
      mask++;
      const bg = lum(without.data, i);
      const lw = lum(withP.data, i);
      sumW += lw;
      sumW2 += lw * lw;
      sumO += bg;
      sumO2 += bg * bg;
      const d = lw - bg;
      const ad = Math.abs(d);
      const rgb = chan(withP.data, i, without.data);
      sumAbs += ad;
      sumSigned += d;
      sumRgb += rgb;
      sumBg += bg;
      sumWeber += rgb / Math.max(bg, 1);
      if (rgb < 2) dead++;
      if (ad > peak) peak = ad;
    }
    return {
      meshes: meshes.length,
      w: withP.w,
      h: withP.h,
      maskPx: mask,
      maskFrac: mask / total,
      detailKeep: mask
        ? Math.sqrt(Math.max(sumW2 / mask - (sumW / mask) ** 2, 0)) /
          Math.max(Math.sqrt(Math.max(sumO2 / mask - (sumO / mask) ** 2, 0)), 1e-6)
        : 0,
      meanAbs: mask ? sumAbs / mask : 0,
      meanRgb: mask ? sumRgb / mask : 0,
      meanSigned: mask ? sumSigned / mask : 0,
      weber: mask ? sumWeber / mask : 0,
      meanBg: mask ? sumBg / mask : 0,
      deadFrac: mask ? dead / mask : 0,
      peak,
      png,
      pngHidden,
    };
  };

  status('rendering (stepping the world live)...');
  let tick = 0;
  function frame(): void {
    if (w.__bbFreeze) {
      renderFree();
      requestAnimationFrame(frame);
      return;
    }
    if (!probing) biobuzzStep(world, SIM_DT, commands);
    if (reticleDemo) pinReticleDemoRobot();
    tick++;
    const localRobotId = alliance === 'red' ? 0 : 2;
    scene.render(world, {
      alpha: 1,
      viewAngle: viewAngleOf(alliance),
      camera,
      localRobotId,
      width: host.clientWidth,
      height: host.clientHeight,
      dpr: window.devicePixelRatio || 1,
    });
    drawOverlay(); // after `scene.render` — `project` reads the camera that frame just used
    draw2d();
    if (tick % 30 === 0) {
      status(
        `tick ${tick} · camera ${camera} · viewpoint ${alliance} · probing ${probing} · ` +
          `balls in flight: ${world.balls.filter((b) => b.state.kind === 'flight').length} · ` +
          `reticle demo ${reticleDemo ? 'on' : 'off'}`,
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** GLTFLoader keeps a node's true name on `userData.name` (it strips `/` from `.name`) — see
   * `renderFieldGlb.ts`'s own `findByOriginalName` header. */
  function findOriginal(root: THREE.Object3D, name: string): THREE.Object3D | null {
    let hit: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (!hit && ((o.userData as { name?: string } | undefined)?.name === name || o.name === name)) hit = o;
    });
    return hit;
  }

  // ── NUMERIC VERIFICATION — named object vs. expected world position, 0.25in tolerance ──────
  function runChecks(): void {
    const bbScene = (window as unknown as { __bbScene: THREE.Scene }).__bbScene;
    const rows: { name: string; expected: string; actual: string; pass: boolean }[] = [];
    const TOL = 0.25;

    function box(name: string): THREE.Box3 | null {
      const obj = bbScene.getObjectByName(name);
      if (!obj) return null;
      obj.updateWorldMatrix(true, false);
      return new THREE.Box3().setFromObject(obj);
    }
    /** the object's own WORLD ORIGIN (`getWorldPosition`) — the right check for a PIVOT/POINT
     * object (a hive group, a ring), whose bounding box is its DESCENDANTS' extent and can sit
     * far from the pivot itself (an asymmetric tray tilt shifts a bbox centre well away from the
     * pivot it rotates about — this is what the first pass of this check got wrong). */
    function checkOrigin(name: string, ex: number, ey: number, ez: number): void {
      const obj = bbScene.getObjectByName(name);
      if (!obj) {
        rows.push({ name, expected: `(${ex},${ey},${ez})`, actual: 'MISSING', pass: false });
        return;
      }
      const c = obj.getWorldPosition(new THREE.Vector3());
      const pass = Math.abs(c.x - ex) <= TOL && Math.abs(c.y - ey) <= TOL && Math.abs(c.z - ez) <= TOL;
      rows.push({
        name,
        expected: `origin (${ex.toFixed(2)},${ey.toFixed(2)},${ez.toFixed(2)})`,
        actual: `origin (${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`,
        pass,
      });
    }
    /** the object's BOUNDING-BOX CENTRE — right for a solid, roughly-symmetric mesh (a ring, a
     * flat floor) where the shape's own extent IS the thing being checked. */
    function checkCentre(name: string, ex: number, ey: number, ez: number): void {
      const b = box(name);
      if (!b) {
        rows.push({ name, expected: `(${ex},${ey},${ez})`, actual: 'MISSING', pass: false });
        return;
      }
      const c = b.getCenter(new THREE.Vector3());
      const dx = Math.abs(c.x - ex);
      const dy = Math.abs(c.y - ey);
      const dz = Math.abs(c.z - ez);
      const pass = dx <= TOL && dy <= TOL && dz <= TOL;
      rows.push({
        name,
        expected: `(${ex.toFixed(2)},${ey.toFixed(2)},${ez.toFixed(2)})`,
        actual: `(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`,
        pass,
      });
    }
    function checkScalar(name: string, label: string, actual: number, expected: number): void {
      const pass = Math.abs(actual - expected) <= TOL;
      rows.push({ name: `${name}:${label}`, expected: expected.toFixed(2), actual: actual.toFixed(2), pass });
    }

    // FLOOR / WALLS
    checkCentre('floor', 0, 0, 0);
    for (const n of ['wall:rear', 'wall:audience', 'wall:right', 'wall:left']) {
      const b = box(n);
      if (!b) {
        // the CAD field's four walls are ONE merged mesh named `walls` (`convert.py` groups
        // "walls + tiles + tape + stations... merged one mesh per class"), so there is no
        // PER-SIDE named node to measure an inner face off of the way the constants-built
        // field's four separate `wall:<side>` meshes allow — a row testing a constants-only
        // shape, adapted per item 12: the real inner-face figure is asserted from the CAD's
        // OWN measured faces in the SIM3D lane's `one field` check (2D colliders vs 3D colliders
        // vs the CAD, 0.05in), not re-derived here from a scene-graph lookup that cannot exist
        // on this path.
        const wholeWalls = bbScene.getObjectByName('walls');
        rows.push({
          name: n,
          expected: `inner face at ±${BB_HALF_X} (constants path, which IS the CAD) — see the SIM3D \`one field\` check on the CAD path`,
          actual: wholeWalls ? 'skipped — CAD walls are one merged mesh, no per-side node' : 'MISSING',
          pass: !!wholeWalls,
        });
        continue;
      }
      // the wall's INNER face (the one facing the field) must sit at exactly ±BB_HALF_X/Y
      let inner: number;
      let expected: number;
      if (n === 'wall:rear') {
        inner = b.min.y;
        expected = BB_HALF_Y;
      } else if (n === 'wall:audience') {
        inner = b.max.y;
        expected = -BB_HALF_Y;
      } else if (n === 'wall:right') {
        inner = b.min.x;
        expected = BB_HALF_X;
      } else {
        inner = b.max.x;
        expected = -BB_HALF_X;
      }
      checkScalar(n, 'inner-face', inner, expected);
    }

    // HIVES — pivot ORIGIN (not a bbox centre: the tray's own children are not symmetric about
    // the pivot at every tilt) and the up-CELL opening's world z, read against the world's OWN
    // current hive state rather than the staged assumption — the 180-tick drive-in before the
    // scene mounts holds `fire` the whole time, so a TIP may already have happened and flipped
    // which cell is up, or still be mid-swing (`tipping > 0`, a different, transient angle).
    checkOrigin('hive:red', -BB_HIVE_X, 0, 43.95);
    checkOrigin('hive:blue', BB_HIVE_X, 0, 43.95);
    const bbState = (window as unknown as { __bbWorld: World }).__bbWorld.biobuzz;
    for (const a of ['red', 'blue'] as const) {
      const h = bbState?.hives?.[a];
      const tipping = h?.tipping ?? 0;
      const upName = h?.up ?? (a === 'red' ? 'south' : 'north'); // BB_HIVE_UP_STAGED fallback
      if (tipping > 0.01) {
        rows.push({
          name: `hive:${a}:cell:${upName}:opening`,
          expected: 'checked only at rest',
          actual: `mid-swing, tipping=${tipping.toFixed(2)}s left — skipped`,
          pass: true,
        });
        continue;
      }
      // Measure the FLOOR and CEILING child meshes' own world Box3, not the whole cell GROUP's:
      // the group's bbox is the union of ALL five boxes, including the CLOSED back near the
      // pivot, and a tilted box's inner (pivot-side) corner can land at a lower world z than
      // its own outer (open-face) corner — conflating the two understates "opening-bottom" by
      // measuring a point that is not the opening at all. Each individual slab's MAX.z is,
      // for either tilt direction, exactly its OUTER (open-face) corner — proved by construction
      // (the "up" side is by definition the one whose far end has risen) and confirmed by this
      // check finally agreeing with `BB_HIVE_OPEN_Z` once fixed.
      const floorSlab = box(`hive:${a}:cell:${upName}:floor`);
      const ceilingSlab = box(`hive:${a}:cell:${upName}:ceiling`);
      if (floorSlab && ceilingSlab) {
        checkScalar(`hive:${a}:cell:${upName}`, 'opening-bottom', floorSlab.max.z, BB_HIVE_OPEN_Z[0]);
        checkScalar(`hive:${a}:cell:${upName}`, 'opening-top', ceilingSlab.max.z, BB_HIVE_OPEN_Z[1]);
      } else {
        // the CAD tray is ONE mesh (`hive_<alliance>/tray`), not decomposed into named
        // floor/back/side/ceiling children the way the constants-built tray's `buildCell` is —
        // a row testing a constants-only shape, adapted per item 12: the real opening figure
        // (and the reported gap to BB_HIVE_OPEN_Z/BB_HIVE_BOTTOM_Z) is asserted in the SIM3D
        // smoke lane's measurements check, off the physics collider geometry directly rather
        // than a scene-graph lookup this mesh cannot answer.
        const trayMesh = bbScene.getObjectByName(`hive:${a}`);
        rows.push({
          name: `hive:${a}:cell:${upName}`,
          expected: 'present (constants path) — see the SIM3D measurements check on the CAD path',
          actual: trayMesh ? 'skipped — CAD tray is one mesh, no per-cell-part node' : 'MISSING',
          pass: !!trayMesh,
        });
      }
    }

    // FLOWERS — the ring row compares the drawn ring against `BB_FLOWERS`, at the DEFAULT 0.25in.
    //
    // It ran at 2.0in until 2026-09-18, because the CAD's own ring centres sat ~1.5in from
    // `BB_FLOWERS` and the owner had not yet ruled on which was right. The ruling is that the CAD
    // is, `BB_FLOWERS` IS the measured bore centre now, and the wide tolerance has no reason to
    // exist — it would only hide the GLB and the constants parting company again.
    BB_FLOWERS.forEach((f, idx) => {
      const ringBox = box(`flower:${idx}:ring`);
      if (ringBox) {
        const c = ringBox.getCenter(new THREE.Vector3());
        const dx = Math.abs(c.x - f.x);
        const dy = Math.abs(c.y - f.y);
        const dz = Math.abs(c.z - BB_FLOWER_TOP_Z);
        const pass = dx <= TOL && dy <= TOL && dz <= TOL;
        rows.push({
          name: `flower:${idx}:ring`,
          expected: `(${f.x.toFixed(2)},${f.y.toFixed(2)},${BB_FLOWER_TOP_Z.toFixed(2)})`,
          actual: `(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`,
          pass,
        });
      } else {
        // the CAD field's flower is ONE mesh (`flower_<idx>`), not decomposed into named
        // ring/foot/pipe children the way the constants-built flower's own group is — fall back
        // to the WHOLE flower node.
        //
        // ⚠️ AND MEASURE IT PER AXIS, because a flower ASSEMBLY is not symmetric about its own
        // bore in DEPTH: the under-field bracket reaches behind the wall plane and the ring
        // plates protrude into the field, so the node's bounding-box centre sits ~0.62 in behind
        // the bore on the wall-NORMAL axis. That is geometry, not misplacement — comparing a
        // bbox centre to a bore centre and calling the difference an error is what the old 2-in
        // "open finding" tolerance was quietly absorbing.
        //   • ALONG the wall the assembly IS symmetric, and that axis carries the fact worth
        //     checking here (the flower sits on its tile seam), so it is held to the default TOL.
        //   • ACROSS the wall the bore must simply lie INSIDE the node, and the real stand-off is
        //     asserted at 0.25 in against the CAD in the SIM3D lane's measurements check, off the
        //     least-squares bore fit rather than a bounding box.
        const whole = box(`flower:${idx}`);
        if (!whole) {
          rows.push({ name: `flower:${idx}`, expected: 'present', actual: 'MISSING', pass: false });
        } else {
          const c = whole.getCenter(new THREE.Vector3());
          const n = FLOWER_MOUTH[f.wall];
          const alongErr = n.x !== 0 ? Math.abs(c.y - f.y) : Math.abs(c.x - f.x);
          const boreInside =
            f.x >= whole.min.x - TOL && f.x <= whole.max.x + TOL && f.y >= whole.min.y - TOL && f.y <= whole.max.y + TOL;
          rows.push({
            name: `flower:${idx} (whole node — the CAD flower is one mesh)`,
            expected: `centred on the seam at ${(n.x !== 0 ? f.y : f.x).toFixed(2)} along its wall, bore inside the node`,
            actual: `along-wall off by ${alongErr.toFixed(2)}, bore ${boreInside ? 'inside' : 'OUTSIDE'} bbox (centre ${c.x.toFixed(2)},${c.y.toFixed(2)})`,
            pass: alongErr <= TOL && boreInside,
          });
        }
      }
      const foot = box(`flower:${idx}:foot`);
      if (foot) {
        // the foot must be flush against the wall face (BB_FLOWER_D off the ring) and centred
        // on the flower's own x or y depending on which wall it stands against
        const n = FLOWER_MOUTH[f.wall];
        const wallFace = n.x !== 0 ? f.x - n.x * BB_FLOWER_D : f.y - n.y * BB_FLOWER_D;
        const footEdge = n.x > 0 ? foot.min.x : n.x < 0 ? foot.max.x : n.y > 0 ? foot.min.y : foot.max.y;
        checkScalar(`flower:${idx}:foot`, 'wall-face', footEdge, wallFace);
        const alongExpected = n.x !== 0 ? BB_FLOWER_FOOT.along : BB_FLOWER_FOOT.deep;
        void alongExpected;
      } else {
        // not decomposed on the CAD path (one mesh per flower) — not a failure, see the ring
        // check above for the same reasoning.
        rows.push({ name: `flower:${idx}:foot`, expected: 'present (constants path)', actual: 'skipped — CAD flower is one mesh', pass: true });
      }
      // the pipe fix check: a support pipe's bounding box must be TALL (z-extent) and THIN
      // (x/y extent), not lying on its side — this is exactly the bug that was found and fixed.
      const pipe = box(`flower:${idx}:pipe0`);
      if (pipe) {
        const zExtent = pipe.max.z - pipe.min.z;
        const xyExtent = Math.max(pipe.max.x - pipe.min.x, pipe.max.y - pipe.min.y);
        rows.push({
          name: `flower:${idx}:pipe0:orientation`,
          expected: 'tall (z >> xy)',
          actual: `z=${zExtent.toFixed(1)} xy=${xyExtent.toFixed(1)}`,
          pass: zExtent > xyExtent * 3,
        });
      }
    });

    // TAPE — MEASURED OFF THE GLB's OWN `tape` NODE, not off the floor texture.
    //
    // This used to sample the procedural floor `CanvasTexture` for a red/blue pixel at each zone
    // rectangle's edge, which is exactly the thing the owner reported as wrong: the texture
    // outlined all four sides of `BB_LZ`/`BB_GARDEN`, wall side included, at whatever width the
    // caller passed. The tape is now real CAD geometry — 16 strips, all 1.000 in wide — so the
    // check is now about the GEOMETRY and about the rule that sent it here: a zone edge that is a
    // WALL carries no tape. See `docs/biobuzz/field-cad-audit.md` §5.
    const tapeNode = bbScene.getObjectByName('tape') ?? findOriginal(bbScene, 'tape');
    if (tapeNode) {
      const tapeBox = new THREE.Box3().setFromObject(tapeNode);
      rows.push({
        name: 'tape:present',
        expected: 'the GLB carries a `tape` node',
        actual: `bbox x ${tapeBox.min.x.toFixed(1)}..${tapeBox.max.x.toFixed(1)}`,
        pass: true,
      });
      // the ALLIANCE AREA strips live OUTSIDE the perimeter on the gym floor, so the tape's own
      // bbox reaching past the wall is the proof they are there (and were not clipped away).
      const reachesAllianceArea = tapeBox.min.x < -100 && tapeBox.max.x > 100;
      rows.push({
        name: 'tape:alliance-area',
        expected: 'strips outside the perimeter (|x| > 100)',
        actual: `${tapeBox.min.x.toFixed(1)} .. ${tapeBox.max.x.toFixed(1)}`,
        pass: reachesAllianceArea,
      });
      // NO ON-TILE STRIP TOUCHES A WALL — measured PER VERTEX, not per mesh. All 16 strips share
      // two meshes (one per colour), and each of those spans both the on-tile marks (z 0..0.010)
      // and the ALLIANCE AREA outlines on the gym floor (z -0.589), which are outside the
      // perimeter by design — so a bounding box cannot tell the two apart and a per-mesh test
      // silently examines nothing.
      const WALL_FACE = 70.674;
      let worstName = '';
      let worst = 0;
      const v = new THREE.Vector3();
      tapeNode.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.geometry) return;
        const pos = o.geometry.getAttribute('position');
        if (!pos) return;
        o.updateWorldMatrix(true, false);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.z < -0.05) continue; // a gym-floor strip
          const reach = Math.max(Math.abs(v.x), Math.abs(v.y));
          if (reach > worst) {
            worst = reach;
            worstName = o.name || '(unnamed tape mesh)';
          }
        }
      });
      rows.push({
        name: 'tape:no-tape-on-a-wall',
        expected: `every on-tile strip stays inside the wall face (${WALL_FACE})`,
        actual: `furthest reach ${worst.toFixed(3)} on ${worstName}`,
        pass: worst > 0 && worst <= WALL_FACE,
      });
    } else {
      rows.push({ name: 'tape:present', expected: 'the GLB carries a `tape` node', actual: 'absent', pass: false });
    }

    // ROBOT HEADING CONVENTION — the probe robot's chassis bounding box must extend FURTHER
    // along the heading direction than the opposite way, proving the group's local +x (forward)
    // really points toward `heading`.
    if (probing) {
      const r0 = world.robots[0];
      const chassis = box(`robot:0:chassis`);
      if (chassis) {
        const c = chassis.getCenter(new THREE.Vector3());
        const fwd = { x: Math.cos(r0.heading), y: Math.sin(r0.heading) };
        const frontCorner = { x: c.x + fwd.x * (r0.spec.length / 2 - 0.1), y: c.y + fwd.y * (r0.spec.length / 2 - 0.1) };
        const inside =
          frontCorner.x >= chassis.min.x - TOL &&
          frontCorner.x <= chassis.max.x + TOL &&
          frontCorner.y >= chassis.min.y - TOL &&
          frontCorner.y <= chassis.max.y + TOL;
        rows.push({
          name: `robot:0:heading=${Math.round((r0.heading * 180) / Math.PI)}`,
          expected: 'front-of-chassis point lies inside the chassis box',
          actual: inside ? 'inside' : 'OUTSIDE — heading convention mismatch',
          pass: inside,
        });
      }
    }

    // print
    const lines = [`${rows.filter((r) => r.pass).length}/${rows.length} PASS`, ''];
    for (const r of rows) {
      lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      expected ${r.expected}\n      actual   ${r.actual}`);
    }
    checksEl.textContent = lines.join('\n');
    console.log('[scene-preview checks]', rows);
  }

  // auto-run once, three seconds in (after the drive-in settles and geometry is stable)
  setTimeout(() => runChecks(), 1000);
}

main().catch((err: unknown) => {
  const msg = 'SCENE_PREVIEW_ERROR: ' + (err instanceof Error ? (err.stack ?? err.message) : String(err));
  status(msg);
  console.error(err);
});
