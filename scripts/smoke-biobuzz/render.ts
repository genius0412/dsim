/**
 * RENDER lane — the 3D scene chunk's import-boundary rules (Day 1, `docs/biobuzz/plan-3d.md`
 * §2.3, §2.5, §9). Pure SOURCE checks, no DOM and no `three` import here: this lane proves the
 * CHUNK BOUNDARY is honoured by reading files as text, the same style as `scripts/smoke.ts`'s
 * own SOURCE GUARD block (~line 14474) — a grep, deliberately, because "don't write this" can
 * only be checked by reading the source, not by running it.
 *
 * Kept fast on purpose (a handful of `readFileSync` calls over a few dozen files): this lane
 * never boots physics or steps a world.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleFor } from '../../src/games';
import { hiveCellTarget } from '../../src/games/biobuzz/elements';
import { bbAimHeading, bbTurretSolution } from '../../src/games/biobuzz/robot';
import { bbAimTarget, bbCellSideOf, bbPretendHive, bbTurretShotEnters } from '../../src/games/biobuzz/play';
import {
  BB3_CHASSIS_TOP_Z,
  BB3_NECTAR_TURRET_R,
  BB3_NECTAR_TURRET_TOP_Z,
  BB3_TURRET_R,
  BB3_TURRET_TOP_Z,
  BB_AIM_TOL,
  BB_CELL_OPEN,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
} from '../../src/games/biobuzz/config';
// -- LANE A (FIELD RENDER) imports, kept in their own block beside lane B's --------------
import {
  BB3_WALL_H,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_LZ,
  BB_NECTAR_R,
  BB_TAPE,
  BB_TAPE_W,
  BB_TILE_SEAMS,
  BB_VIEW_MARGIN,
} from '../../src/games/biobuzz/config';
// THE FIELD MAT'S SURFACE (2026-09-21) — `scene/renderTiles.ts` is deliberately almost all pure
// functions over numbers, so the seam the owner asked for is MEASURED here rather than grepped.
import {
  BB_TILE_TOOTH,
  bbTileDetail,
  buildTileGrain,
  TILE_GRAIN_REPEAT,
  TILE_GROOVE,
  TILE_LINE,
  TILE_MAT,
  TILE_TEX_SIZE,
  tileSeamPaths,
  tileSeamPolyline,
  tileTone,
} from '../../src/games/biobuzz/scene/renderTiles';
import { drawBiobuzzField, snapTapeGroup } from '../../src/games/biobuzz/drawField';
// the CAD loader's own DOM-free exports — the AprilTag bitmap, the ID table the manual sets, and
// the creased-normal pass. Importing a `scene/` module here is fine: this is a script, not the
// bundle, and the chunk-boundary checks above read the SOURCE rather than the module graph.
import {
  CREASE_ANGLE_DEG,
  TAG_CELL_IN,
  TAG_IDS as BB_TAG_IDS,
  TAG_SIZE_IN,
  apriltag36h11Cells,
  clearPanelAlphaAt,
  clearPanelLightIndependent,
  clearPanelPresence,
  clearPanelSheenGain,
  clearPanelVeilAt,
  computeCreasedNormals,
  sheetFacingBalance,
  CLEAR_SHEETS_ARE_SINGLE_SIDED,
  assembleFieldGroups,
  hiveFrameComponents,
  HIVE_FRAME_NODES,
  weldedComponents,
  shellWindingStats,
  analyseMeshShells,
} from '../../src/games/biobuzz/scene/renderFieldGlb';
import { cadCaptureTheta, fieldColliders3d } from '../../src/games/biobuzz/sim3d/fieldColliders';
import { COLORS as SHARED_COLORS } from '../../src/config';
import {
  BB_BOX_DEPTH,
  BB_BOX_H,
  BB_BOX_LEN,
  BB_BOX_SLOTS,
  bbNectarBoxRect,
  bbNectarBoxSlot,
} from '../../src/games/biobuzz/nectarBox';
// ── LANE B (ROBOT RENDER) imports — the 3D robot model's own checks, kept in their own block so
// they are easy to see and easy to move. ───────────────────────────────────────────────────────
import type { RobotSpec, RobotState } from '../../src/types';
import { bbFlowerInReach, bbFootprint, bbMouths, bbPlacePointLocal, bbRobotSolids } from '../../src/games/biobuzz/robot';
import { chassis3dShapes } from '../../src/games/biobuzz/sim3d/bodies';
import {
  BB_END_BAR_INSET,
  BB_FRONT_INK,
  BB_REAR_INK,
  bbBoxTubeGlyph,
  bbEndBarSegments,
  bbFrontMarks,
} from '../../src/games/biobuzz/parts';
import { BB_INTAKE_KINDS, bbIntakeKindOf, bbLiftOf } from '../../src/games/biobuzz/mechs';
import { drawBiobuzzIntakeReach } from '../../src/games/biobuzz/drawRobot';
import {
  BB_BOX_TUBE_ARM_T,
  BB_BOX_TUBE_ARM_W,
  BB_BOX_TUBE_BASE_BELOW,
  BB_BOX_TUBE_CLAW_REACH,
  BB_BOX_TUBE_EXTEND_S,
  BB_BOX_TUBE_FLOWER_GAP,
  BB_BOX_TUBE_JAW_H,
  BB_BOX_TUBE_JAW_L,
  BB_BOX_TUBE_PALM_BACK,
  BB_BOX_TUBE_RETRACT_F,
  BB_BOX_TUBE_SECTIONS,
  BB_BOX_TUBE_TIP_CLEAR,
  BB_BOX_TUBE_WALL,
  BB_BOX_TUBE_WRIST_E,
  BB_BOX_TUBE_WRIST_H,
  BB_BOX_TUBE_WRIST_HALF,
  BB_BOX_TUBE_WRIST_TOP,
  BB_BOX_TUBE_YOKE_OUT,
  BB_BOX_TUBE_CLAW_HALF,
  BB_BOX_TUBE_Z,
  bbBoxTubeJoints,
  bbBoxTubePhases,
  bbBoxTubePose,
  bbLiftPlaceLocal,
  bbMechEnvelopes,
  bbTowerBoxRobot,
  BB_BRACE_PROUD,
  BB_DECK_Z,
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_OUTER_MAX,
  BB_FLOWER_OUTER_MIN,
  BB_FLOWER_TOP_Z,
  bbFlowerOuterR,
  FLOWER_MOUTH,
  FLOWER_RING_Z,
  BB_PLACE_TOL,
  BB_FEED_WALL_T,
  BB_FLYWHEEL_CLEAR,
  BB_FLYWHEEL_D_MM,
  BB_FLYWHEEL_R,
  bbHead,
  BB_HOOD_ARM_T,
  BB_HOOD_SIDE_CLEAR,
  BB_HOOD_T,
  BB_HOOD_WRAP,
  BB_INTAKE_THROAT_FRAC,
  BB_LAUNCH_Z0,
  BB_MOTOR_MOUNT_RIM,
  BB_RAMP_ANGLE,
  BB_RAMP_DEPLOY_S,
  BB_RAMP_DECK_Z,
  BB_RAMP_WEDGE_THICK,
  BB_RAMP_FLOOR_Z,
  BB_RAMP_IN,
  BB_RAMP_L,
  BB_RAMP_OUT,
  BB_RAMP_PIVOT_BACK,
  BB_RAMP_PIVOT_Z,
  BB_RAMP_TIP_Z,
  BB_SHOOTER_PLATE_T,
  BB_SIDE_PLATE_BOTTOM_Z,
  BB_SIDE_PLATE_FRONT_X,
  BB_SIDE_PLATE_TOP_Z,
  BB_FLOWER_RETRIEVE_Z,
  BB_SIDE_ROLLER_BOSS_R,
  BB_SIDE_ROLLER_HUB_R,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_PROTRUDE,
  BB_SIDE_ROLLER_R,
  BB_SIDE_ROLLER_REACH,
  bbSideRollerY,
  bbSideRollerYokeY,
  BB_MIN_LENGTH,
  BB_MAX_LENGTH,
  BB_MIN_WIDTH,
  BB_MAX_WIDTH,
  BB_TURRET_AXLE_Z,
  BB_TURRET_BRACE_R,
  BB_TURRET_BRACES,
  BB_TURRET_MOTOR_R,
  BB_TURRET_PITCH_MAX,
  BB_DEG,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_REST,
  BB_TURRET_PLATE_TOP_Z,
  BB3_HEIGHT_DEFAULT,
  BB3_HEIGHT_MAX,
  BB3_HEIGHT_MIN,
  BB3_MOUTH_SLOT_Z,
  BB3_STOW_MAX,
} from '../../src/games/biobuzz/config';
// ⚠️ THE ONE PLACE IN THIS LANE THAT REACHES INTO `scene/`, AND THE ONLY SCRIPT THAT IMPORTS
// `three`. The chunk-boundary rules this file enforces are about `src/`; a Node smoke script is
// not bundled, and `buildTurret` touches no DOM. It is here because five passes of shooter
// geometry were signed off by a lane that could only grep the source — see its own header, and
// the SHOOTER block below.
import {
  BB_INTAKE_ARM_INSET,
  BB_SIGN_DIGIT_H,
  BB_SIGN_H,
  BB_SIGN_MARGIN,
  BB_SIGN_MIN_H,
  BB_SIGN_MIN_W,
  BB_SIGN_W,
  BB_WHEEL_PARTS,
  BB_XDRIVE_INSET_X,
  BB_XDRIVE_INSET_Y,
  bbRobotSignOrientation,
  bbRobotSignText,
  bbWheelDetail,
  buildBoxTube,
  buildDriveWheel,
  buildEndPlates,
  buildFrame,
  buildFrontMarks,
  buildIntake,
  buildRobotGroup,
  buildSwervePod,
  buildTurret,
  buildWheels,
  disposeRobotGroup,
  endWheelSpanY,
  poseBoxTubeRig,
  wheelKindOf,
} from '../../src/games/biobuzz/scene/renderRobots';
import { lengthLimits } from '../../src/sim/drivetrain';
import { BB_MOUNT_POSITIONS, bbMouthFrame, turretLocal, type BbMountPos } from '../../src/games/biobuzz/mounts';
import { bbMuzzleLocal } from '../../src/games/biobuzz/robot';
import { INTAKE_RAIL_T } from '../../src/config';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/coerce';
import { bbCoerceSpec } from '../../src/games/biobuzz/robotConfig';
import { bbCoerce } from './harness';
import { bbSpecKey } from '../../src/games/biobuzz/specKey';
import { SHOT, SHOT_ARC_MAX, shotArc, solveShotPath } from '../../src/games/biobuzz/shotPath';
import { drawBiobuzzShotPath } from '../../src/games/biobuzz/drawShot';
import { CAMERA_PREFS, fallBackTo2d, getCameraPref, getViewPref, resolveSceneCamera, setViewPref } from '../../src/games/biobuzz/graphics/store';
import { VIEW_KEY } from '../../src/storageKeys';
import {
  bindFreeCamCustom,
  clampFreeCam,
  defaultFreeCam,
  dollyFreeCam,
  dollyFreeCamToward,
  coerceFreeCamNav,
  freeCamBindLabel,
  freeCamNavFor,
  freeCamOrbitDelta,
  freeCamPanGain,
  freeCamWheelDir,
  freeCamWheelSign,
  FREE_CAM_NAV_DEFAULT,
  FREE_CAM_PRESET_HINT,
  FREE_CAM_PRESET_LABEL,
  FREE_CAM_PRESET_WHEEL,
  FREE_CAM_PRESETS,
  freeCamGesture,
  freeCamPose,
  orbitFreeCam,
  panFreeCam,
  FREE_CAM_DIST_MAX,
  FREE_CAM_DIST_MIN,
  FREE_CAM_PITCH_MAX,
  FREE_CAM_PITCH_MIN,
  type FreeCamBind,
  type FreeCamGesture,
  type FreeCamPreset,
  type FreeCamState,
} from '../../src/games/biobuzz/graphics/freeCam';
import {
  coerceDriverHeightIn,
  driverEyeAim,
  driverEyeFollow,
  fieldViewPoints,
  fitDriverEyeFrame,
  driverEyePoint,
  pointsInFrame,
  DRIVER_HEIGHT_MAX_IN,
  DRIVER_HEIGHT_MIN_IN,
  EYE_VERTEX_OFFSET_IN,
  ROLE_ALONG_WALL_FRACTION,
  STAND_BACK_IN,
  type DriverRole,
} from '../../src/games/biobuzz/graphics/driverEye';
import { ALLIANCE_AREA } from '../../src/games/biobuzz/fieldDims.gen';
import { hFovFromV, vFovFromH, HUMAN_BINOCULAR_HFOV_DEG } from '../../src/games/biobuzz/graphics/fov';
// the wheel block below needs the preset COLUMNS (to assert the tier mapping) and the sim's own
// wheel diameter (to assert the drawn mecanum IS the wheel the drive model is derived from)
import { GFX_PRESETS } from '../../src/games/biobuzz/graphics/settings';
import * as C from '../../src/config';
import { bbRoleLabel } from '../../src/games/biobuzz/config';
import { createCameras, setCameraTuning, setDriverHeightIn } from '../../src/games/biobuzz/scene/renderCameras';
import type { SceneFrame } from '../../src/games/module';
import { viewAngleOf } from '../../src/sim/field';
import {
  GFX_PIXEL_BUDGET,
  GFX_PRESETS,
  GFX_TIERS,
  getGraphics,
  resetGraphicsToAuto,
  setGraphicsTier,
  coerceGraphicsSettings,
  coerceMaxFps,
  effectivePixelRatio,
  fpsFromSliderPos,
  frameIntervalMs,
  GFX_FPS_MAX,
  GFX_FPS_MIN,
  GFX_FPS_SLIDER_MAX,
  GFX_FPS_SLIDER_NO_CAP,
  GFX_FPS_STEPS,
  isCustomFps,
  matchesPreset,
  MAX_FPS_UNLIMITED,
  MAX_FPS_VSYNC,
  msaaSamples,
  shadowMapSize,
  sliderPosFromFps,
} from '../../src/games/biobuzz/graphics/settings';
import {
  SLIP_MS,
  SLIP_WINDOW_MS,
  STALL_MS,
  WARMUP_DOWN_MS,
  WARMUP_MS,
  WARMUP_UP_MS,
  createQualityGovernor,
  firstGuess,
  p95,
  stepTier,
  type GpuProbe,
} from '../../src/games/biobuzz/graphics/auto';
import {
  BASE_RIG,
  BB_ENVIRONMENTS,
  BB_ENVIRONMENT_IDS,
  canFetchHdri,
  environmentDef,
  environmentDefFor,
  hdriEnvironments,
  pickableEnvironments,
  type VenueSpec,
} from '../../src/games/biobuzz/graphics/environments';
import { bbVenueDetail, buildBiobuzzVenue } from '../../src/games/biobuzz/scene/renderVenue';
import { ENVIRONMENT_IDS, type EnvironmentId } from '../../src/games/biobuzz/graphics/settings';
import { drawBiobuzzFlowerReadout } from '../../src/games/biobuzz/drawFlowerReadout';
import { BIOBUZZ_MODULE } from '../../src/games/biobuzz';
import type { SceneOverlayView } from '../../src/games/module';
import { THIRD_PARTY } from '../../src/contributors';
import { Renderer } from '../../src/render/renderer';
import type { RobotSpec, World } from '../../src/types';
import { mkWorld, type Check } from './harness';
// COSMETICS (Day 4, `docs/cosmetics-plan.md`) — the 2D halo/decal helpers are DOM-free, so they
// are checked directly against a stub context, same as the tape probe above.
import { drawDecal, drawRobot as drawDecodeRobot, ROBOT_TRIM } from '../../src/render/drawRobot';
import { drawChainRobot } from '../../src/games/chain/drawRobot';
import { createChainWorld } from '../../src/games/chain/spawn';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { drawBiobuzzRobot } from '../../src/games/biobuzz/drawRobot';
import { createWorld as createDecodeWorld } from '../../src/sim/spawn';
// -- THE PERFORATED CAD SCORING ELEMENTS (2026-09-21), in their own import block --------
import { BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { buildBiobuzzElements, setElementDetail, updateBiobuzzElements } from '../../src/games/biobuzz/scene/renderElements';
import { ELEMENT_RADIUS_TOL_IN } from '../../src/games/biobuzz/scene/renderElementsGlb';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIOBUZZ_DIR = join(root, 'src', 'games', 'biobuzz');
const SCENE_DIR = join(BIOBUZZ_DIR, 'scene');

/** every `.ts`/`.tsx` file under `dir`, recursively, as paths relative to the repo root. */
/**
 * THE SHIPPED FIELD ASSET, DECODED ONCE AT MODULE LOAD — GL-free, in Node, through the very
 * loader the app uses. It is a TOP-LEVEL await because a lane function is synchronous and
 * `GLTFLoader.parse` is not: `EXT_meshopt_compression` is required by this file, so the decoder's
 * wasm has to come up before a single triangle exists. ~1 s, once, and it is what lets the
 * back-face check below measure the REAL geometry instead of a belief about it.
 */
async function parseShippedGlb(file: string): Promise<THREE.Group | null> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const buf = readFileSync(join(here, '..', '..', 'public', 'models', 'biobuzz', file));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    return await new Promise<THREE.Group | null>((resolve) => {
      loader.parse(ab, '', (g) => resolve(g.scene), () => resolve(null));
    });
  } catch {
    return null;
  }
}
const FIELD_GLB_SCENE: THREE.Object3D | null = await parseShippedGlb('field.glb');
/** the LOW LOD too — the hive's mis-filed parts have to be found on BOTH, and it is the one the
 *  `assembleFieldGroups` check can run end to end, because only the HIGH path wants a canvas. */
const FIELD_LOW_GLB_SCENE: THREE.Group | null = await parseShippedGlb('field-low.glb');

/** ⚠️ ONE FRESH PARSE PER BLOCK THAT CALLS `assembleFieldGroups`. It mutates its argument in
 *  place — resolved PBR materials over the glTF's `<finish>#<hex>` names, repaired index buffers,
 *  replaced geometries — so a second call on the same object reads its own output back through
 *  `parseMaterialName`, which rejects it and repaints the field grey. These four feed the
 *  WHOLE-FIELD WINDING REPAIR blocks at the end of `renderChecks`. */
const WIND_RAW_HIGH: THREE.Group | null = await parseShippedGlb('field.glb');
const WIND_FIX_HIGH: THREE.Group | null = await parseShippedGlb('field.glb');
const WIND_PRISTINE_HIGH: THREE.Group | null = await parseShippedGlb('field.glb');
const WIND_CLEAR_HIGH: THREE.Group | null = await parseShippedGlb('field.glb');
const WIND_FIX_LOW: THREE.Group | null = await parseShippedGlb('field-low.glb');
/** and the SCORING ELEMENTS. `elements.glb` is a separate asset from a separate pipeline
 * (`scripts/field-cad/elements.mjs`) but the same pinned STEP, so it decodes the same way. */
const ELEMENTS_GLB_SCENE: THREE.Group | null = await parseShippedGlb('elements.glb');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkTs(p));
      continue;
    }
    if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** `p`, relative to the repo root, forward-slashed regardless of platform — a Windows
 * checkout must not turn a path-prefix assertion into a false negative. */
function relPosix(p: string): string {
  return relative(root, p).split('\\').join('/');
}

/** strip line and block comments the crude way `smoke.ts`'s own guard does — good enough for a
 * grep whose false positives would only be inside a comment describing the very string. */
function codeLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''));
}

export function renderChecks(check: Check): void {
  const allFiles = walkTs(BIOBUZZ_DIR);
  const sceneFiles = allFiles.filter((p) => p.startsWith(SCENE_DIR + '\\') || p.startsWith(SCENE_DIR + '/'));

  check('scene/ actually has files (else every check below is vacuous)', sceneFiles.length > 0, String(sceneFiles.length));

  // ---- every file under scene/ is named render*.ts ---------------------------------------
  const badNames = sceneFiles.filter((p) => !/^render[^/\\]*\.ts$/.test(relative(SCENE_DIR, p)));
  check(
    'every file under src/games/biobuzz/scene/ is named render*.ts',
    badNames.length === 0,
    badNames.map(relPosix).join(', '),
  );

  // ---- `three` (bare OR a subpath) appears ONLY under scene/, anywhere in src/ -----------
  /**
   * ⚠️ TWO HOLES, BOTH OF WHICH LET A THREE.JS IMPORT INTO THE MAIN CHUNK UNSEEN.
   *
   * It matched the BARE specifier only, so `import { GLTFLoader } from 'three/examples/jsm/...'`
   * — which is how three's loaders and controls are actually reached, and which pulls three
   * itself in as a dependency — read as not an import of three at all. And it scanned only
   * `src/games/biobuzz/**`, so the same line in `src/ui/`, `src/render/` or `src/lib/` was
   * outside the scan entirely; those are ordinary MAIN-chunk files, which is the worst place for
   * it and the only place this check exists to protect. The sim3d boundary scan three blocks
   * below has always walked all of `src/` — this is the same statement about the other chunk.
   */
  const threeRx = /from\s+['"]three(\/[^'"]*)?['"]|import\(\s*['"]three(\/[^'"]*)?['"]\s*\)/;
  const isSceneFile = (p: string): boolean => p.startsWith(SCENE_DIR + sep) || p.startsWith(SCENE_DIR + '/');
  const threeOutside: string[] = [];
  const threeInside: string[] = [];
  for (const p of walkTs(join(root, 'src'))) {
    codeLines(p).forEach((line, i) => {
      if (!threeRx.test(line)) return;
      (isSceneFile(p) ? threeInside : threeOutside).push(`${relPosix(p)}:${i + 1}`);
    });
  }
  check('every scene/ render file that uses three.js actually imports it (else the next check is vacuous)', threeInside.length > 0);
  check("'three' (bare or a subpath) is imported ONLY by files under scene/, across all of src/", threeOutside.length === 0, threeOutside.join(', '));

  // ---- nothing outside index.ts imports from ./scene, and index.ts only dynamically ------
  const sceneImportRx = /from\s+['"](\.\/)?scene(\/[^'"]*)?['"]|import\(\s*['"]\.\/scene[^'"]*['"]\s*\)/;
  const staticSceneImports: string[] = [];
  const dynamicSceneImports: string[] = [];
  for (const p of allFiles) {
    if (sceneFiles.includes(p)) continue; // files inside scene/ importing each other are fine
    codeLines(p).forEach((line, i) => {
      if (!sceneImportRx.test(line)) return;
      const loc = `${relPosix(p)}:${i + 1}`;
      if (/import\(/.test(line)) dynamicSceneImports.push(loc);
      else staticSceneImports.push(loc);
    });
  }
  check(
    'nothing outside scene/ imports it STATICALLY',
    staticSceneImports.length === 0,
    staticSceneImports.join(', '),
  );
  // ⚠️ TWO SLOTS, ONE SPECIFIER. `index.ts` fills `scene` (the match view) and `previewScene`
  // (the robot-builder turntable, `docs/roadmap.md` item 1), and BOTH write
  // `import('./scene/renderScene')` — the preview factory is re-exported from there rather than
  // imported by its own path. That is not tidiness: one dynamic specifier is ONE Rollup chunk, and
  // two would hoist three.js into a shared chunk with a thin facade either side. A facade carries
  // none of the marker strings `scripts/bundleaudit.mjs` routes the `scene` budget by, so both
  // would land in `other` and fail that audit for a reason with nothing to do with size. So the
  // rule is: every dynamic scene import is in `index.ts`, and they all name the same module.
  check(
    'every dynamic import(\'./scene/...\') is in index.ts',
    dynamicSceneImports.length > 0 && dynamicSceneImports.every((l) => l.startsWith('src/games/biobuzz/index.ts:')),
    dynamicSceneImports.join(', '),
  );
  {
    const indexSrc = readFileSync(join(BIOBUZZ_DIR, 'index.ts'), 'utf8');
    const specifiers = new Set(
      [...indexSrc.matchAll(/import\(\s*['\"](\.\/scene\/[^'\"]*)['\"]\s*\)/g)].map((m) => m[1]),
    );
    check(
      'and they all name ONE module, so the chunk stays one measurable file',
      specifiers.size === 1 && specifiers.has('./scene/renderScene'),
      [...specifiers].join(', '),
    );
  }

  // ---- THE 3D PHYSICS IMPORT BOUNDARY — the other half of the same rule ------------------
  //
  // `three` is kept out of the main chunk by the checks above. THIS is the same statement about
  // `sim3d/`, and it is here because it shipped broken: `step.ts` imported `step3d` directly and
  // `scene/renderField.ts` imported two helpers out of `hive3d.ts`/`bodies.ts`, so the whole 3D
  // implementation — bodies, the CAD collider set, derive, the gameplay passes, the predictors,
  // ~225 KB of source — was statically reachable from the entry and landed in the MAIN chunk,
  // which every player of every game downloads to play a 2D match. `npm run bundleaudit` is what
  // MEASURES that (it reads a real build); this is what NAMES the file, in `npm test`, before a
  // build is run at all.
  //
  // THE RULE: only the LIGHT seam may be imported from outside `sim3d/`.
  //   engine.ts  — the loader (`initPhysics3d`/`physics3dReady`/`rapier3d`/`physics3dImpl`)
  //   tilt.ts    — `hiveTiltAngle`/`hiveTrayRefTheta`, pure JSON, for a 3D VIEW of a 2D match
  //   step3d.ts  — the one-line gate `step.ts` dispatches through
  // `scene/` gets ONE extra: `fieldColliders.ts`, the CAD geometry the GLB loader reads. That is
  // a real shared dependency of two LAZY chunks (the scene and the physics implementation), so it
  // costs the main chunk nothing — see `scripts/bundleaudit.mjs`, which routes it.
  {
    const SIM3D_DIR = join(BIOBUZZ_DIR, 'sim3d');
    const inDir = (p: string, dir: string): boolean => p.startsWith(dir + sep) || p.startsWith(dir + '/');
    const LIGHT = new Set(['engine', 'tilt', 'step3d']);
    const SCENE_EXTRA = new Set(['fieldColliders']);
    const srcFiles = walkTs(join(root, 'src'));
    const heavyImports: string[] = [];
    let lightImports = 0;
    for (const p of srcFiles) {
      if (inDir(p, SIM3D_DIR)) continue; // sim3d/ importing itself is the whole point of sim3d/
      const inScene = inDir(p, SCENE_DIR);
      codeLines(p).forEach((line, i) => {
        for (const m of line.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]*sim3d\/[A-Za-z0-9_.]+)['"]/g)) {
          const name = m[1].slice(m[1].lastIndexOf('sim3d/') + 'sim3d/'.length);
          if (LIGHT.has(name) || (inScene && SCENE_EXTRA.has(name))) {
            lightImports++;
            continue;
          }
          heavyImports.push(`${relPosix(p)}:${i + 1} (sim3d/${name})`);
        }
      });
    }
    check('the import-boundary scan sees sim3d imports at all (else the next check is vacuous)', lightImports > 0, String(lightImports));
    check(
      'nothing under src/ outside sim3d/ imports a HEAVY sim3d module (engine, tilt, step3d only)',
      heavyImports.length === 0,
      heavyImports.join(', '),
    );

    // and the seam is only light because its OWN imports are: a `from './bodies'` added to any of
    // the three would put the implementation straight back where it was, and pass the check above.
    const seamLeaks: string[] = [];
    for (const name of LIGHT) {
      codeLines(join(SIM3D_DIR, `${name}.ts`)).forEach((line, i) => {
        for (const m of line.matchAll(/from\s*['"]\.\/([A-Za-z0-9_.]+)['"]/g)) {
          if (!LIGHT.has(m[1])) seamLeaks.push(`sim3d/${name}.ts:${i + 1} -> ./${m[1]}`);
        }
      });
    }
    check('the LIGHT seam itself statically imports no other sim3d module', seamLeaks.length === 0, seamLeaks.join(', '));

    // the barrel: reached ONLY by the loader, and only through `import()`.
    const implRefs: string[] = [];
    let allDynamicInLoader = true;
    for (const p of srcFiles) {
      codeLines(p).forEach((line, i) => {
        if (!/(?:from|import)\s*\(?\s*['"](?:[^'"]*sim3d\/impl|\.\/impl)['"]/.test(line)) return;
        const loc = `${relPosix(p)}:${i + 1}`;
        implRefs.push(loc);
        if (!/import\s*\(/.test(line) || !loc.startsWith('src/games/biobuzz/sim3d/engine.ts:')) allDynamicInLoader = false;
      });
    }
    check(
      "sim3d/impl.ts is reached ONLY by engine.ts, and only through import()",
      implRefs.length > 0 && allDynamicInLoader,
      implRefs.join(', '),
    );

    // …and every heavy module is IN the barrel, so a new one cannot be orphaned outside the
    // lazy chunk (or, worse, pulled in by whoever happens to import it first).
    const starred = new Set(
      [...readFileSync(join(SIM3D_DIR, 'impl.ts'), 'utf8').matchAll(/export \* from '\.\/([A-Za-z0-9_.]+)'/g)].map((m) => m[1]),
    );
    const missing = readdirSync(SIM3D_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .filter((n) => !LIGHT.has(n) && n !== 'impl' && n !== 'fieldColliders.gen' && !starred.has(n));
    check('sim3d/impl.ts re-exports every heavy sim3d module (a new one has to join the barrel)', missing.length === 0, missing.join(', '));
  }

  // ---- BOTH RENDERERS DRAW THE CAD'S OWN TAPE AND THE CAD'S OWN TILE SEAMS ----------------
  //
  // A SOURCE check, because the failure it guards is a renderer drawing something that is not on
  // the field, and no headless run of the sim can see a canvas. Two specific regressions, both of
  // which shipped:
  //
  //  - TAPE AS AN OUTLINE OF THE ZONE. `strokeRect(BB_LZ[a], ...)` / `strokeRectTex(...)` paints
  //    all FOUR edges of a zone rectangle, including the one that is a perimeter WALL and carries
  //    no tape on the real field, and it turns the GARDEN's solid 2-in band into a 1-in outline
  //    of a 2-in rectangle. `BB_TAPE` is the CAD's own 16 measured strips; both renderers draw it.
  //  - THE 24-IN TILE GRID. `C.TILE` is 24, which is DECODE's and Chain Reaction's nominal tile.
  //    A real FTC soft tile is 23.528 on centre (`BB_TILE_PITCH`), so a grid stepped by 24 drifts
  //    almost half an inch per tile away from the tape, the flowers and the GLB. Both renderers
  //    draw `BB_TILE_SEAMS`, the seven measured seam lines.
  {
    const renderers = ['src/games/biobuzz/drawField.ts', 'src/games/biobuzz/scene/renderField.ts'];
    for (const rel of renderers) {
      const src = readFileSync(join(root, rel), 'utf8');
      check(`${rel} draws the CAD tape strips (BB_TAPE), not an outline of a zone rectangle`, src.includes('BB_TAPE.loadingZone') && src.includes('BB_TAPE.garden'), rel);
      check(`${rel} draws the CAD tile seams (BB_TILE_SEAMS)`, src.includes('BB_TILE_SEAMS'), rel);
      const code = codeLines(join(root, rel)).map((l, i) => ({ l, i })).filter((r) => /\bC\.TILE\b/.test(r.l));
      check(
        `${rel} does NOT step a grid by the shared C.TILE (24in is not this field's tile)`,
        code.length === 0,
        code.map((r) => `${rel}:${r.i + 1}`).join(', '),
      );
      // ...and it does not reach for DECODE's tape width either. `C.TAPE_W` and `BB_TAPE_W` are
      // both 1 in by coincidence -- one is DECODE's field, one is the BIOBUZZ CAD's -- and a
      // BIOBUZZ width with two homes is a width that can drift in one of them (owner, 2026-09-19:
      // "tape mark widths are inconsistent").
      const tapeW = codeLines(join(root, rel)).map((l, i) => ({ l, i })).filter((r) => /\bC\.TAPE_W\b/.test(r.l));
      check(
        `${rel} does NOT read the shared C.TAPE_W (this field's width is BB_TAPE_W, from the CAD)`,
        tapeW.length === 0,
        tapeW.map((r) => `${rel}:${r.i + 1}`).join(', '),
      );
    }

    // THE TWO RENDERERS DRAW THE SAME LIST OF MARKS. Derived from the source rather than stated,
    // so a group added to one and not the other fails here instead of in a screenshot.
    const groupsOf = (rel: string): string =>
      [...new Set([...codeLines(join(root, rel)).join('\n').matchAll(/BB_TAPE\.([A-Za-z]+)/g)].map((m) => m[1]))]
        .sort()
        .join(',');
    const twoD = groupsOf('src/games/biobuzz/drawField.ts');
    const threeD = groupsOf('src/games/biobuzz/scene/renderField.ts');
    check('the 2D and 3D renderers draw the SAME tape groups', twoD === threeD, `2D=${twoD} 3D=${threeD}`);
    check(
      'and that list is the field guide\'s: the LOADING ZONES, the GARDENS, and the corner supplement',
      twoD === 'garden,gardenSupplement,loadingZone',
      twoD,
    );
  }

  // ---- ONE TAPE WIDTH, AND IT IS THE CAD'S --------------------------------------------------
  //
  // Event Field Guide V1.0 §8.1 (p13): the field may be taped with EITHER 1 in or 2 in ProGaff,
  // "the outside perimeter of each zone should be consistent with the specifications, but the tape
  // width may vary". §8.3's figure draws the LOADING ZONE both ways; §8.4's draws the GARDEN as
  // [2] 1-in pieces OR [1] 2-in piece. The CAD ships the 1-in build -- `tape.widthsIn` is a
  // ONE-element list -- so that is the build the sim draws, and `BB_TAPE_W` is the one name for it.
  //
  // This is the data half of the owner's "tape mark widths are inconsistent": every rectangle a
  // renderer fills has to BE that width, not merely come from the same file.
  {
    for (const group of ['loadingZone', 'garden', 'allianceArea'] as const) {
      for (const a of ['red', 'blue'] as const) {
        const strips = BB_TAPE[group][a];
        const wrong = strips.filter((s) => Math.abs(Math.min(s.x1 - s.x0, s.y1 - s.y0) - BB_TAPE_W) > 1e-6);
        check(
          `${group}/${a}: every strip is exactly BB_TAPE_W across`,
          strips.length > 0 && wrong.length === 0,
          `${strips.length} strips, ${wrong.length} off ${BB_TAPE_W}in`,
        );
      }
    }
    // the GARDEN's "approximately 2 in." (§8.4) is TWO of them laid side by side with no mat
    // between -- the band is solid, which is the difference between a band and an outline.
    for (const a of ['red', 'blue'] as const) {
      const band = BB_TAPE.garden[a];
      const lo = Math.min(...band.map((s) => s.y0));
      const hi = Math.max(...band.map((s) => s.y1));
      const edges = [...band.map((s) => s.y0), ...band.map((s) => s.y1)].sort((p, q) => p - q);
      check(`garden/${a}: the band is exactly 2 x BB_TAPE_W deep`, Math.abs(hi - lo - 2 * BB_TAPE_W) < 1e-6, `${(hi - lo).toFixed(3)}in`);
      check(`garden/${a}: ...and the two tapes TOUCH, so the band is solid`, band.length === 2 && Math.abs(edges[1] - edges[2]) < 1e-6, edges.join(','));
    }
  }

  // ---- NO CENTRE CROSS: THE FIELD HAS NO MARKING AT THE ORIGIN ------------------------------
  //
  // Owner, 2026-09-19: "centre cross tape mark does not exist, I think. Check manual." It does
  // not. Event Field Guide V1.0 §8 "Tape Placement" installs exactly three things -- §8.3 LOADING
  // ZONES, §8.4 GARDENS, §8.5 ALLIANCE AREAS -- and manual Fig 9-2 (p65) shows no marking at the
  // centre. It could not have one: guide §9.1 has you REMOVE the four centre tiles for the
  // frame's under-tile strips, so the origin is bare tile under the HIVE structure.
  //
  // Both renderers drew a white cross 8 in across at tape width there, for the gallery's benefit.
  // The 2D half is checked by RUNNING it (the calls are the behaviour, the same way the shot path
  // is checked below): every tape-coloured rectangle has to be one of the CAD's strips, and the
  // only WHITE line inside the perimeter has to be the perimeter itself.
  {
    interface Rect { x: number; y: number; w: number; h: number; fill: string }
    interface Seg { x0: number; y0: number; x1: number; y1: number; stroke: string }
    const rects: Rect[] = [];
    const segs: Seg[] = [];
    let fillStyle = '';
    let strokeStyle = '';
    let tx = 0;
    let ty = 0;
    let scale = 1;
    let rotated = false;
    const stack: [number, number, number, boolean][] = [];
    let cur: [number, number] | null = null;
    const pending: Seg[] = [];
    const ctx = {
      save() { stack.push([tx, ty, scale, rotated]); },
      restore() { const p = stack.pop(); if (p) { [tx, ty, scale, rotated] = p; } },
      translate(x: number, y: number) { tx += scale * x; ty += scale * y; },
      scale(sx: number) { scale *= sx; },
      rotate() { rotated = true; },
      transform() { rotated = true; },
      setTransform() { rotated = true; },
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
      fillRect(x: number, y: number, w: number, h: number) {
        if (!rotated) rects.push({ x: tx + scale * x, y: ty + scale * y, w: scale * w, h: scale * h, fill: fillStyle });
      },
      strokeRect() {},
      beginPath() { cur = null; pending.length = 0; },
      moveTo(x: number, y: number) { cur = [tx + scale * x, ty + scale * y]; },
      lineTo(x: number, y: number) {
        const p: [number, number] = [tx + scale * x, ty + scale * y];
        if (cur && !rotated) pending.push({ x0: cur[0], y0: cur[1], x1: p[0], y1: p[1], stroke: strokeStyle });
        cur = p;
      },
      stroke() { for (const s of pending) segs.push({ ...s, stroke: strokeStyle }); pending.length = 0; },
      closePath() { cur = null; },
      fill() { pending.length = 0; },
      clip() {}, rect() {}, arc() {}, arcTo() {}, ellipse() {}, setLineDash() {}, drawImage() {},
      fillText() {}, strokeText() {}, measureText() { return { width: 0 }; },
      set fillStyle(v: string) { fillStyle = v; },
      get fillStyle() { return fillStyle; },
      set strokeStyle(v: string) { strokeStyle = v; },
      get strokeStyle() { return strokeStyle; },
      set lineWidth(_v: number) {}, set lineCap(_v: string) {}, set lineJoin(_v: string) {},
      set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      set globalAlpha(_v: number) {},
    } as unknown as CanvasRenderingContext2D;

    drawBiobuzzField(ctx, mkWorld('solo', 7), { x: 0, y: 1 });

    // the two gaffer colours this renderer uses -- read off the source rather than re-typed, so a
    // palette edit cannot make this check blind instead of red.
    const drawSrcTape = readFileSync(join(root, 'src/games/biobuzz/drawField.ts'), 'utf8');
    const gaffer = [...drawSrcTape.matchAll(/TAPE_GAFFER[^=]*=\s*\{[^}]*\}/g)]
      .flatMap((m) => [...m[0].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((c) => c[1].toLowerCase()));
    const blueTape = /const ALLIANCE_BLUE = '(#[0-9a-fA-F]{6})'/.exec(drawSrcTape)?.[1].toLowerCase();
    if (blueTape) gaffer.push(blueTape);
    check('the 2D renderer names two gaffer colours', new Set(gaffer).size === 2, gaffer.join(','));

    const expected = (['loadingZone', 'garden', 'gardenSupplement'] as const).flatMap((g) =>
      (['red', 'blue'] as const).flatMap((a) => BB_TAPE[g][a].map((s) => `${s.x0.toFixed(3)},${s.y0.toFixed(3)},${(s.x1 - s.x0).toFixed(3)},${(s.y1 - s.y0).toFixed(3)}`)),
    );
    const painted = rects
      .filter((r) => gaffer.includes(String(r.fill).toLowerCase()))
      .map((r) => `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w.toFixed(3)},${r.h.toFixed(3)}`);
    check(
      'the 2D field paints exactly the CAD strips it claims, and nothing else in a tape colour',
      painted.length === expected.length && [...painted].sort().join('|') === [...expected].sort().join('|'),
      `${painted.length} painted vs ${expected.length} expected`,
    );

    // ══ EVERY TAPE ON SCREEN IS ONE WIDTH, IN PIXELS ═════════════════════════════════════════
    // Owner, 2026-09-19, the FIFTH report of "tape widths look inconsistent" — and the data was
    // never wrong (the check above; every strip is 1.000 in). The map draws at 2–6 device px per
    // inch, so a 1-in strip is ~3.1 px and where its edges fall inside a pixel decided whether it
    // came out as three solid columns or two solid and two half-lit. `snapTapeGroup` gives every
    // strip of a zone the same whole-pixel width on a real canvas. Swept over scales, sub-pixel
    // offsets, both y senses and both axis-aligned rotations: one width, the LOADING ZONE's U
    // closed with no pixel painted twice and none missed, the GARDEN band exactly two widths.
    {
      let cases = 0;
      let badWidth = 0;
      let badJoin = 0;
      let badBand = 0;
      for (let sc = 1.3; sc < 9; sc += 0.137) {
        for (let off = 0; off < 1; off += 0.23) {
          for (const flip of [1, -1]) {
            for (const quarter of [false, true]) {
              const m = quarter
                ? { a: 0, b: sc, c: -sc * flip, d: 0, e: 400.3 + off, f: 300.7 + off * 2 }
                : { a: sc, b: 0, c: 0, d: -sc * flip, e: 400.3 + off, f: 300.7 + off * 2 };
              const w = Math.max(1, Math.round(sc * BB_TAPE_W));
              for (const a of ['red', 'blue'] as const) {
                cases++;
                const lz = snapTapeGroup(m, BB_TAPE.loadingZone[a]);
                if (!lz || lz.some(([, , ww, hh]) => Math.min(ww, hh) !== w)) badWidth++;
                if (lz) {
                  const x0 = Math.min(...lz.map((r) => r[0]));
                  const y0 = Math.min(...lz.map((r) => r[1]));
                  const W = Math.max(...lz.map((r) => r[0] + r[2])) - x0;
                  const H = Math.max(...lz.map((r) => r[1] + r[3])) - y0;
                  const grid = new Uint8Array(W * H);
                  for (const [x, y, ww, hh] of lz) {
                    for (let j = y; j < y + hh; j++) for (let i = x; i < x + ww; i++) grid[(j - y0) * W + (i - x0)]++;
                  }
                  // a closed U of thickness w on three sides of a W×H box covers exactly this many
                  // pixels once each: the two full-depth strips plus the span between them
                  const depth = lz.map((r) => Math.max(r[2], r[3])).sort((p, q) => p - q);
                  const want = 2 * w * depth[0] + w * (depth[2] - 0) ;
                  let painted = 0;
                  let twice = 0;
                  for (const v of grid) {
                    if (v) painted++;
                    if (v > 1) twice++;
                  }
                  const area = lz.reduce((acc, r) => acc + r[2] * r[3], 0);
                  const spans = Math.max(W, H) === depth[2] + 2 * w; // the inner strip reaches both depth strips exactly
                  if (twice !== 0 || painted !== area || !spans || !(want > 0)) badJoin++;
                }
                const garden = [...BB_TAPE.garden[a], ...BB_TAPE.gardenSupplement[a]];
                const band = {
                  x0: Math.min(...garden.map((r) => r.x0)),
                  y0: Math.min(...garden.map((r) => r.y0)),
                  x1: Math.max(...garden.map((r) => r.x1)),
                  y1: Math.max(...garden.map((r) => r.y1)),
                };
                const gd = snapTapeGroup(m, [band]);
                if (!gd || Math.min(gd[0][2], gd[0][3]) !== 2 * w) badBand++;
              }
            }
          }
        }
      }
      check('tape: every LOADING ZONE strip is the same whole-pixel width at every scale and offset', badWidth === 0, `${badWidth} of ${cases}`);
      check('tape: the LOADING ZONE’s U closes exactly — no pixel twice, none missed, the inner strip meets both', badJoin === 0, `${badJoin} of ${cases}`);
      check('tape: the GARDEN band is exactly two tape widths (Fig 9-3: two 1-in tapes side by side)', badBand === 0, `${badBand} of ${cases}`);
      check(
        'tape: a rotated view is left to the rasteriser (there is no pixel grid to snap to)',
        snapTapeGroup({ a: 0.7, b: 0.7, c: -0.7, d: 0.7, e: 0, f: 0 }, BB_TAPE.loadingZone.red) === null,
      );
      const garden = [...BB_TAPE.garden.red, ...BB_TAPE.gardenSupplement.red];
      const bandArea =
        (Math.max(...garden.map((r) => r.x1)) - Math.min(...garden.map((r) => r.x0))) *
        (Math.max(...garden.map((r) => r.y1)) - Math.min(...garden.map((r) => r.y0)));
      const sum = garden.reduce((acc, r) => acc + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
      check('tape: the GARDEN’s two strips and its corner patch TILE their band (so it may be drawn as one)', Math.abs(bandArea - sum) < 1e-6, `${bandArea.toFixed(4)} vs ${sum.toFixed(4)}`);
      const drawSrc2 = readFileSync(join(root, 'src/games/biobuzz/drawField.ts'), 'utf8');
      check(
        'tape: the 2D map paints each zone through the snapped group, never strip by strip',
        drawSrc2.includes('fillTapeGroup(ctx, BB_TAPE.loadingZone[a], TAPE_GAFFER[a]);') &&
          drawSrc2.includes('fillTapeGroup(ctx, garden, TAPE_GAFFER[a], [bandOf(garden)]);') &&
          !/for \(const strip of BB_TAPE\.\w+\[a\]\) fillStrip\(/.test(drawSrc2),
      );
    }
    // every painted mark is BB_TAPE_W across -- the same statement as the data check above, but
    // made against what actually reached the canvas.
    const tapeRects = rects.filter((r) => gaffer.includes(String(r.fill).toLowerCase()));
    const offWidth = tapeRects.filter((r) => Math.abs(Math.min(Math.abs(r.w), Math.abs(r.h)) - BB_TAPE_W) > 1e-6);
    check(
      'every painted STRIP is exactly one tape wide',
      tapeRects.length > 0 && offWidth.length === 2,
      `${tapeRects.length} marks, ${offWidth.length} not one tape across`,
    );
    // the two exceptions are the garden corner PATCHES, and they are the band's own 2 x depth by a
    // length shorter than a tape -- a bridge to the wall, not a marking with a width of its own.
    check(
      '...and the two that are not are the garden corner patches: 2 x deep, under a tape long',
      offWidth.length === 2 &&
        offWidth.every(
          (r) => Math.abs(Math.max(Math.abs(r.w), Math.abs(r.h)) - 2 * BB_TAPE_W) < 1e-6 && Math.min(Math.abs(r.w), Math.abs(r.h)) < BB_TAPE_W,
        ),
      offWidth.map((r) => `${r.w.toFixed(3)}x${r.h.toFixed(3)}`).join(' '),
    );

    // THE CENTRE CROSS ITSELF: no white line anywhere inside the perimeter. The cross was two
    // 8-in white segments through the origin; the perimeter, the only other white line on this
    // canvas, sits ON the wall.
    const inside = segs.filter(
      (s) =>
        String(s.stroke).toLowerCase() === SHARED_COLORS.white.toLowerCase() &&
        Math.max(Math.abs(s.x0), Math.abs(s.x1)) < BB_HALF_X - 1e-6 &&
        Math.max(Math.abs(s.y0), Math.abs(s.y1)) < BB_HALF_Y - 1e-6,
    );
    check(
      'the 2D field draws NO white line inside the perimeter (there is no centre mark on this field)',
      inside.length === 0,
      inside.map((s) => `(${s.x0.toFixed(1)},${s.y0.toFixed(1)})->(${s.x1.toFixed(1)},${s.y1.toFixed(1)})`).join(' '),
    );
    check('...and the probe was not vacuous -- the renderer did stroke and fill', segs.length > 0 && rects.length > 0, `${segs.length} segs, ${rects.length} rects`);

    // the 3D half is a source check, because the floor texture needs a DOM canvas.
    const floorSrc = readFileSync(join(root, 'src/games/biobuzz/scene/renderField.ts'), 'utf8');
    const at = floorSrc.indexOf('function buildFloorTexture(');
    const body = at < 0 ? '' : floorSrc.slice(at, floorSrc.indexOf('function buildFloor(', at));
    const originAnchored = /toTex\(0,\s*0\)/.test(body.replace(/\/\/.*$/gm, ''));
    check(
      'the 3D floor texture paints the seam grid and the tape, and nothing at the origin',
      body.length > 0 && !originAnchored,
      body.length === 0 ? 'buildFloorTexture not found' : originAnchored ? 'toTex(0, 0) is back' : `${body.length} chars scanned`,
    );

    // ═══ THE MAT READS AS THIRTY-SIX SOFT TILES (owner, 2026-09-21: "For higher graphics
    //     settings, have proper texture and the proper pattern of the field tile (where two
    //     tiles meet). More accurate colour would be good too") ═══════════════════════════════
    //
    // `scene/renderTiles.ts` carries the measurement: the part is `am-2499`, the field has 36 of
    // them in three variants, and the interlock is a 50 %-duty SQUARE castellation at period
    // 2.369 in, half-amplitude 0.405 in — all of it read off the same sha-pinned STEP
    // `npm run field-cad` uses. Everything below is arithmetic on the real polyline, because a
    // seam that misses its own tile corner is exactly the failure a source grep cannot see.

    // (1) THE PITCH DIVIDES THE FIELD. A grid that does not land on the CAD's own seams looks
    //     worse than no grid at all, and `BB_TILE_SEAMS` is the only place the answer lives.
    check('the tile grid is 6 cells per axis over the CAD seam lines', BB_TILE_SEAMS.length === 7, `${BB_TILE_SEAMS.length} lines`);
    {
      const spans = BB_TILE_SEAMS.slice(1).map((s, i) => s - BB_TILE_SEAMS[i]);
      const worst = Math.max(...spans.map((s) => Math.abs(s - 23.5283)));
      check('...and every cell is within half an inch of TILE_PITCH (the CAD seams are NOT even)', worst < 0.5, `worst ${worst.toFixed(3)} in`);
      const total = BB_TILE_SEAMS[6] - BB_TILE_SEAMS[0];
      check('...and the six of them sum to the CAD tile footprint, 141.17 in', Math.abs(total - 141.1696) < 0.01, `${total.toFixed(4)}`);
    }

    // (2) THE SEAM IS THE CASTELLATION, ON ITS OWN SEAM LINE, AND IT CLOSES AT THE TILE CORNER.
    {
      const at = BB_TILE_SEAMS[3];
      const a = BB_TILE_SEAMS[2];
      const b = BB_TILE_SEAMS[3];
      const pts = tileSeamPolyline(at, a, b, 'x');
      const devs = pts.map((p) => p[0] - at);
      const A = BB_TILE_TOOTH.amplitude;
      check('a seam run deviates by exactly ±the measured tab projection, never in between',
        devs.every((d) => Math.abs(Math.abs(d) - A) < 1e-9), `${devs.length} points, A=${A}`);
      check('...and it is NOT a straight line (the check is not vacuous)', new Set(devs.map((d) => Math.sign(d))).size === 2);
      check('...and it starts and ends on the tile corners it runs between',
        Math.abs(pts[0][1] - a) < 1e-9 && Math.abs(pts[pts.length - 1][1] - b) < 1e-9,
        `${pts[0][1]} .. ${pts[pts.length - 1][1]}`);
      // TEN TEETH TO AN EDGE, at the measured period stretched to fit the cell — never truncated,
      // because a part-tooth straddling a tile corner is the one thing that reads as a mistake.
      const flips = pts.filter((p, i) => i > 0 && p[0] !== pts[i - 1][0]).length;
      check('ten teeth to an edge, so no tooth straddles a corner', flips === 2 * BB_TILE_TOOTH.perEdge, `${flips} flips`);
      const period = (b - a) / BB_TILE_TOOTH.perEdge;
      check('...and the stretched period stays within 1.5 % of the CAD\'s 2.369 in',
        Math.abs(period - BB_TILE_TOOTH.period) / BB_TILE_TOOTH.period < 0.015, `${period.toFixed(4)} in`);
      // 50 % DUTY, and the CELL CENTRE sits in a GAP — where the CAD puts it (its own centre gap
      // is measured at 11.377…12.156 of a 23.99-in edge).
      let hi = 0;
      let lo = 0;
      for (let i = 1; i < pts.length; i++) {
        const run = pts[i][1] - pts[i - 1][1];
        if (run <= 0) continue;
        if (pts[i][0] > at) hi += run;
        else lo += run;
      }
      check('the wave is 50 % duty — as much tab as notch along the seam', Math.abs(hi - lo) < 1e-6, `${hi.toFixed(4)} vs ${lo.toFixed(4)}`);
      const mid = (a + b) / 2;
      const seg = pts.findIndex((p, i) => i > 0 && pts[i - 1][1] <= mid && p[1] >= mid);
      check('...and the cell centre falls in a NOTCH, the phase the CAD has', seg > 0 && pts[seg][0] < at, `centre dev ${seg > 0 ? (pts[seg][0] - at).toFixed(3) : 'n/a'}`);
    }

    // (3) THE PERIMETER OF THE MAT IS STRAIGHT, and that is CAD, not a simplification: the field
    //     carries 16 `am-2499-Side` and 4 `am-2499-Corner` tiles whose outer edges are cut flat,
    //     which is why the tiled floor measures exactly 6 × TILE_PITCH with nothing poking out.
    {
      const tiled = tileSeamPaths('tiles');
      const flat = tileSeamPaths('flat');
      const straight = tiled.filter((p) => !p.interior);
      check('the mat\'s own perimeter edge is straight on all four sides', straight.length === 4 && straight.every((p) => p.points.length === 2), `${straight.length}`);
      check('...and the five interior seams per axis are toothed, one run per cell',
        tiled.filter((p) => p.interior).length === 2 * 5 * 6, `${tiled.filter((p) => p.interior).length}`);
      // THE LOW COLUMN PAYS NOTHING. `flat` is the straight 14-line grid that shipped before any
      // of this, and it is the whole of what a Low device draws.
      check('the flat tier is still the fourteen straight grid lines it always was',
        flat.length === 14 && flat.every((p) => p.points.length === 2 && !p.interior), `${flat.length}`);
    }

    // (4) THE TIER LADDER — `meshDetail` alone, the one value `createBiobuzzScene` hands
    //     `buildBiobuzzField` (the field is built before the scene object exists, so there is no
    //     `tier` to read there), and already resolved against the fixed tier an EXPORT runs at.
    check('Low gets the flat mat and everything else gets the tiles', bbTileDetail('low') === 'flat' && bbTileDetail('high') === 'tiles');
    check('...and Low keeps the 1024-texel canvas, with 2048 only where the teeth need it',
      TILE_TEX_SIZE.flat === 1024 && TILE_TEX_SIZE.tiles === 2048);
    check('...and the grain textures are not even allocated on Low', buildTileGrain('flat') === null);
    // THE GRAIN IS A WHOLE NUMBER OF PERIODS PER TILE (4), which is the physical answer and not
    // a convenience: the 36 tiles are identical translated copies of one moulding, so the fine
    // surface has to repeat in phase from tile to tile. A repeat that did not divide the grid
    // would drift the grain across the field and read as a texture laid over the mat.
    check('the grain repeats a whole number of times per tile (4), in phase on every one',
      TILE_GRAIN_REPEAT % (BB_TILE_SEAMS.length - 1) === 0 && TILE_GRAIN_REPEAT / (BB_TILE_SEAMS.length - 1) === 4, `${TILE_GRAIN_REPEAT}`);

    // (5) NO DOUBLE-MULTIPLY. `MeshStandardMaterial` multiplies `color` by `map`, so a tone
    //     passed as both comes out squared and near black — the venue's ground shipped exactly
    //     that bug. The floor's albedo is the canvas and nothing else, and the two new map slots
    //     carry no colour at all (an sRGB decode on a normal or roughness map is the same class
    //     of silent wrongness one level down).
    {
      const fat = floorSrc.indexOf('function buildFloor(');
      const fbody = fat < 0 ? '' : floorSrc.slice(fat, floorSrc.indexOf('function wallMaterial(', fat));
      check('the floor material takes a map and NO colour',
        /new THREE\.MeshStandardMaterial\(\{ map: buildFloorTexture\(withTape, detail\) \}\)/.test(fbody) && !/color:/.test(fbody),
        `${fbody.length} chars`);
      check('...and it takes the grain on the normal and roughness slots',
        fbody.includes('material.normalMap = grain.normalMap') && fbody.includes('material.roughnessMap = grain.roughnessMap'));
      const tileSrc = readFileSync(join(root, 'src/games/biobuzz/scene/renderTiles.ts'), 'utf8');
      check('...and neither grain map is decoded as sRGB', /srgb \? THREE\.SRGBColorSpace : THREE\.NoColorSpace/.test(tileSrc) && /mk\(canvas, false\)/.test(tileSrc) && /mk\(rough, false\)/.test(tileSrc));
    }

    // (6) THE 3D MAT IS A REAL TILE GREY, and how far it may go is MEASURED rather than
    //     chosen. A field tile is grey EVA foam (AndyMark am-2499, spec "Gray"), not the
    //     near-black the 2D board paints, so the 3D floor was lifted to one — and the 2D
    //     `COLORS.mat`/`COLORS.tile` were deliberately NOT touched, because repainting
    //     DECODE's board was never the ask. What stops the lift going further is below.
    {
      const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
      const chan = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const lum = (h: string): number => { const c = chan(h); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
      const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      for (const [name, next, token] of [['mat', TILE_MAT, SHARED_COLORS.mat], ['line', TILE_LINE, SHARED_COLORS.tile]] as const) {
        const c = chan(next);
        check(`the 3D ${name} is NEUTRAL grey — the CAD's own tile hue, not DECODE's blue mat`, c[0] === c[1] && c[1] === c[2], next);
        check(`...and the 3D ${name} is LIGHTER than the 2D token, which is the point of it`,
          lum(next) > lum(token), `${next} vs ${token}`);
      }
      /**
       * ⚠️ **ON-FIELD TEXT IS THE CEILING NOW, NOT THE DRIVER LABEL** (owner, 2026-09-21:
       * lighten the mat, strengthen the label stroke).
       *
       * The mat used to be locked to `COLORS.tile`'s luminance because the driver label's FILL
       * was measured against the lightest ground it crosses. `LABEL_STROKE` is OPAQUE now
       * (`render/renderer.ts`), so a glyph reads against its own halo and that pair stopped
       * moving with the field — which is what let the mat go to a real tile grey at all.
       *
       * What binds instead is canvas TEXT drawn over the field: `--ds-on-field-dim`. MEASURED,
       * #585858 put it at 3.77 and was backed out for it. Both floors are asserted here so the
       * next lift has to answer to them rather than rediscover them.
       */
      const ON_FIELD_DIM = '#b9beb8';
      check(
        '⚠️ the mat stays dark enough for canvas ON-FIELD TEXT to clear AA (this is the real ceiling)',
        ratio(ON_FIELD_DIM, TILE_MAT) >= 4.5 && ratio(ON_FIELD_DIM, TILE_LINE) >= 4.5,
        `mat ${ratio(ON_FIELD_DIM, TILE_MAT).toFixed(2)} line ${ratio(ON_FIELD_DIM, TILE_LINE).toFixed(2)}`,
      );
      check(
        '⚠️ the driver label clears AA against its OWN STROKE — the pair that does not move with the field',
        ratio('#f87171', '#14161a') >= 4.5 && ratio('#60a5fa', '#14161a') >= 4.5,
        `red ${ratio('#f87171', '#14161a').toFixed(2)} blue ${ratio('#60a5fa', '#14161a').toFixed(2)}`,
      );
      check(
        '⚠️ ...and that stroke is OPAQUE, which is the whole reason the pair holds',
        /const LABEL_STROKE = 'rgb\(/.test(readFileSync(join(root, 'src/render/renderer.ts'), 'utf8')),
        'an alpha stroke lets the ground through the halo, and the ceiling comes back',
      );
      // THE PER-TILE TONE NEVER GOES UP. `TILE_MAT` is the measured ceiling (see above); a
      // jitter that could brighten is a jitter that could walk a measured pair past its floor
      // without anything failing.
      const tones = [] as string[];
      for (let iy = 0; iy < 6; iy++) for (let ix = 0; ix < 6; ix++) tones.push(tileTone(ix, iy));
      /* HOW MANY DISTINCT TONES 8-BIT sRGB HAS IN THE JITTER'S RANGE IS A FUNCTION OF THE BASE,
         so it is DERIVED rather than written down — at the old near-black mat it was four, and
         a lighter mat has more room. What is actually under test is that the jitter resolves to
         SEVERAL tones and they are mixed up; a hard-coded count just breaks on every re-tone. */
      const base = chan(TILE_MAT)[0];
      const want = new Set(Array.from({ length: 64 }, (_, k) => Math.round(base * (1 - (k / 63) * 0.08)))).size;
      // 36 draws from `want` buckets will usually miss one, so the band is want-1…want. The
      // FLOOR is what is under test (the jitter is not being quantised down to a flat sheet);
      // the CEILING is a tripwire on a range that grew without anyone measuring the darkest tile.
      const got = new Set(tones).size;
      check('the 36 tiles take very nearly every tone 8-bit sRGB has in the jitter range',
        got >= want - 1 && got <= want, `${got} distinct, ${want} available at base ${base}`);
      const neighbours = tones.filter((t, i) => i % 6 > 0 && t !== tones[i - 1]).length;
      check('...and the tones are scattered, not laid in blocks', neighbours >= 15, `${neighbours} of 30 adjacent pairs differ`);
      check('...and not one of them is lighter than the mat itself', tones.every((t) => lum(t) <= lum(TILE_MAT) + 1e-12));
      check('...and the groove under the seam is darker than the mat, so it can only widen a ratio', lum(TILE_GROOVE) < lum(TILE_MAT));
      // DETERMINISM: the same field on every machine and in every exported frame.
      const again = [] as string[];
      for (let iy = 0; iy < 6; iy++) for (let ix = 0; ix < 6; ix++) again.push(tileTone(ix, iy));
      check('the mat is deterministic — two builds paint the same 36 tones', again.join() === tones.join());
      const p1 = JSON.stringify(tileSeamPaths('tiles'));
      check('...and the same seams', p1 === JSON.stringify(tileSeamPaths('tiles')));
    }
  }

  // ---- the seam itself: GameModule.scene is a function ------------------------------------
  const mod = moduleFor('biobuzz');
  check('biobuzz fills the GameModule.scene slot, and it is a function', typeof mod.scene === 'function');
  check('decode does NOT fill it (no 3D renderer)', moduleFor('decode').scene === undefined);
  check('chain does NOT fill it (no 3D renderer)', moduleFor('chain').scene === undefined);

  // ══ DAY 2 ═══════════════════════════════════════════════════════════════════════════════

  // ---- THE SHOT PATH (Lane C, owner playtest feedback 2026-09-18 items 5 + 6) -------------
  //
  // ⚠️ THIS BLOCK REPLACES THE DAY 2 "RETICLE'S BALLISTICS" CHECKS, and the seven that went are
  // not a coverage loss — they pinned a LANDING RING that no longer exists, and the integrator
  // they were guarding against drift is gone too. `scene/renderLanding.ts` carried a COPY of
  // `play.ts`'s `bbFlightEnters` loop (a boolean cannot be asked for a position), and its own
  // header said the copy would drift; `bbFlightEnters` now records its arc into a caller-owned
  // buffer, so there is ONE loop and `src/games/biobuzz/shotPath.ts` is the only predictor. What
  // is worth checking therefore changed shape: not "where does the ring go" but "is the verdict
  // right, and does the drawn path end where the element does".
  //
  // THE CONTRACT: a path is produced ONLY for a shot that goes in. Out of range, aimed away,
  // barrel short of the arc, cell mid-swing ⇒ `false`, and BOTH renderers then draw nothing.
  {
    const cell = hiveCellTarget('blue', 'north');

    /** a blue turret parked at `(x, y)` with its turret and pitch already ON the solution — i.e.
     * a robot that is lined up and ready, which is the only state a path is ever drawn in.
     *
     * ⚠️ A CELL OPENS ALONG ±y, so a shot has to ARRIVE along y (`hiveAccepts` refuses anything
     * not travelling inboard). Parking the fixture out along +x from the north cell instead was
     * the first version of these checks and every shot correctly reported NOT MADE. */
    const aimed = (x: number, y: number): World => {
      const w = mkWorld('practice', 11);
      const r = w.robots[0];
      r.pos.x = x;
      r.pos.y = y;
      r.heading = 0.4;
      w.biobuzz!.hives.blue.up = 'north';
      w.biobuzz!.hives.blue.tipping = 0;
      const sol = bbTurretSolution(r, bbAimTarget(w, r), 0)!;
      r.turretHeading = sol.yaw;
      r.bbTurretPitch = sol.pitch;
      r.hopper.push('yellow');
      return w;
    };

    // 40 in OUT along +y from the north cell, so the arc comes back down the way the cell opens
    const w = aimed(cell.pos.x, cell.pos.y + 40);
    const made = solveShotPath(w, w.robots[0]);
    check(
      'shot path: a lined-up turret in range reports MADE, with a drawable path',
      made && SHOT.made && SHOT.points >= 2 && SHOT.points <= SHOT_ARC_MAX,
      `made=${made} points=${SHOT.points} of ${SHOT_ARC_MAX}`,
    );
    // the LAST point is where the element is accepted — inside the cell's opening footprint, at
    // opening height. This is what ties the drawn line to `hiveAccepts` rather than to a radius
    // the renderer invented.
    const k = (SHOT.points - 1) * 3;
    const endDx = Math.abs(shotArc[k] - cell.pos.x);
    const endDy = Math.abs(shotArc[k + 1] - cell.pos.y);
    const endZ = shotArc[k + 2];
    check(
      'shot path: it ENDS inside the CELL’s opening footprint, at opening height',
      endDx <= BB_CELL_OPEN.w / 2 && endDy <= BB_CELL_OPEN.d / 2 && endZ >= BB_HIVE_OPEN_Z[0],
      `end (${shotArc[k].toFixed(2)}, ${shotArc[k + 1].toFixed(2)}, ${endZ.toFixed(2)}) vs cell (${cell.pos.x.toFixed(2)}, ${cell.pos.y.toFixed(2)}, ${BB_HIVE_OPEN_Z[0]})`,
    );
    check(
      'shot path: the FIRST point is one tick out of the muzzle, not at the target',
      Math.hypot(shotArc[0] - w.robots[0].pos.x, shotArc[1] - w.robots[0].pos.y) < 12,
      `${shotArc[0].toFixed(2)}, ${shotArc[1].toFixed(2)}`,
    );

    // A TURRET STILL SLEWING IS NOT A SHOT. Swing the barrel 40° off its solution and the path has
    // to vanish — this is item 5, and it is the half that is easy to get wrong, because the arc
    // still integrates perfectly well, it just does not arrive.
    const w2 = aimed(cell.pos.x, cell.pos.y + 40);
    w2.robots[0].turretHeading += 0.7;
    check(
      'shot path: a turret 40° off its solution reports NOT MADE (nothing is drawn)',
      !solveShotPath(w2, w2.robots[0]) && !SHOT.made && SHOT.points === 0,
      `points=${SHOT.points}`,
    );

    // ⚠️ THE HOOD A ROBOT SPAWNS WITH, AND THE BUILDER PREVIEW SHOWS, (`BB_TURRET_PITCH_REST`) IS ONE THE
    // AIM SOLVE ACTUALLY PRODUCES. It was the level pose — the tallest the hood has, and one no
    // HIVE shot reaches — so the builder preview drew a hood the sim never raises that far
    // (owner, 2026-09-24). Swept over the field on a DOUBLE turret, both exits.
    {
      const twin = { scoreMode: 'twinturret', bbMech: { launcher: { kind: 'twinturret', mount: 'left', mount2: 'right', hoodDeg: 75 }, lift: null } } as unknown as Partial<RobotSpec>;
      let lo = Infinity;
      let hi = -Infinity;
      for (let x = -60; x <= 60; x += 12) {
        for (let y = -60; y <= 60; y += 12) {
          for (const h of [0, 2.4]) {
            const wt = mkWorld('practice', 11, twin);
            const rt = wt.robots[0];
            rt.pos.x = x;
            rt.pos.y = y;
            rt.heading = h;
            for (const which of [0, 1] as const) {
              const s = bbTurretSolution(rt, bbAimTarget(wt, rt), which);
              if (!s) continue;
              lo = Math.min(lo, s.pitch);
              hi = Math.max(hi, s.pitch);
            }
          }
        }
      }
      check(
        'turret: the spawn/preview hood pose is inside the elevation band the HIVE aim solve produces',
        BB_TURRET_PITCH_REST >= lo && BB_TURRET_PITCH_REST <= hi && lo > BB_TURRET_PITCH_MIN,
        `show ${(BB_TURRET_PITCH_REST / BB_DEG).toFixed(1)}° vs solved ${(lo / BB_DEG).toFixed(1)}°…${(hi / BB_DEG).toFixed(1)}°`,
      );
    }

    // ⚠️ THE PATH'S VERDICT IS THE FIRE GATE'S, POSE FOR POSE (owner ruling, 2026-09-19: the path
    // is drawn "in the case that we can make the shot assuming that the hive is completely up on
    // the side that we are aiming for"). Stage 5b's gate asks `bbTurretShotEnters` of
    // `bbPretendHive(hive, bbCellSideOf(target))`; so does the path, and this re-asks it by hand
    // over a spread of poses — the far corner included, which used to read NOT MADE only because
    // the REAL hive had the nearer cell down.
    {
      let disagree = 0;
      let mades = 0;
      const poses: [number, number][] = [[-60, -60], [-60, 60], [60, -60], [60, 60], [0, -50], [0, 50], [-40, 0], [40, 0], [cell.pos.x, cell.pos.y + 40], [cell.pos.x, 5]];
      for (const [px, py] of poses) {
        const wp = aimed(px, py);
        const rp = wp.robots[0];
        const tp = bbAimTarget(wp, rp);
        const solp = bbTurretSolution(rp, tp, 0);
        const gate =
          !!solp && solp.reachable && bbTurretShotEnters(bbPretendHive(wp.biobuzz!.hives[rp.alliance], bbCellSideOf(tp)), rp, 0, solp.speed, 1 / 60);
        const path = solveShotPath(wp, rp);
        if (path) mades++;
        if (path !== gate) disagree++;
      }
      check('shot path: over a spread of poses the path is drawn EXACTLY when the fire gate would release', disagree === 0 && mades > 0 && mades < poses.length, `${disagree} disagreements, ${mades}/${poses.length} made`);
    }

    // AND THE CLOSED SIDE: parked between the two cells, the nearer one is the one facing away.
    const w3b = aimed(cell.pos.x, 5);
    check(
      'shot path: from between the cells (the nearer one faces away) reports NOT MADE',
      !solveShotPath(w3b, w3b.robots[0]) && !SHOT.made,
    );

    // THE AIMED CELL IS ASSUMED FULLY UP (owner ruling, 2026-09-19). Flip it DOWN and the path is
    // still drawn: what the path promises is the SHOT, not the tray's timing, and a driver lining
    // up on the cell that is about to come up is exactly who needs it. This check used to assert
    // the opposite ("the REAL hive is read").
    const w4 = aimed(cell.pos.x, cell.pos.y + 40);
    w4.biobuzz!.hives.blue.up = 'south';
    check(
      'shot path: the same shot at a cell that is DOWN is still MADE (the aimed cell is assumed up)',
      solveShotPath(w4, w4.robots[0]) && SHOT.made && SHOT.points >= 2,
      `points=${SHOT.points}`,
    );

    // ⚠️ **A SHOT THAT CANNOT BE TAKEN IS AS UN-MADE AS ONE THAT FALLS SHORT** (owner,
    // 2026-09-19: "the dotted lines still appear when the shot is not able to be made").
    // `bbCanFire` is the non-ballistic half of the gate and these are its three clauses.
    {
      const wEmpty = aimed(cell.pos.x, cell.pos.y + 40);
      wEmpty.robots[0].hopper.length = 0;
      check(
        'shot path: an EMPTY hopper reports NOT MADE (there is no shot to promise)',
        !solveShotPath(wEmpty, wEmpty.robots[0]) && !SHOT.made && SHOT.points === 0,
        `points=${SHOT.points}`,
      );
      const wPre = aimed(cell.pos.x, cell.pos.y + 40);
      wPre.match = { ...wPre.match, phase: 'pre' };
      check(
        'shot path: outside a LIVE phase reports NOT MADE (nothing fires in `pre`)',
        !solveShotPath(wPre, wPre.robots[0]) && !SHOT.made,
        `phase=${wPre.match.phase}`,
      );
      const wPassive = aimed(cell.pos.x, cell.pos.y + 40);
      wPassive.robots[0].passive = true;
      check('shot path: a PASSIVE practice dummy reports NOT MADE', !solveShotPath(wPassive, wPassive.robots[0]) && !SHOT.made);
      // A SWINGING HIVE DOES NOT DARKEN THE PATH EITHER — same ruling. For one afternoon this
      // refused outright (`hive.tipping > 0`), because a mid-swing cell was the whole residual of
      // "a path was drawn and the shot did not score" (28 of 28 in 3D). The owner's rule is that
      // the path answers for the shot with the aimed side assumed up; whether the tray is there
      // when the element arrives is the driver's call, off the HUD's cell state.
      const wTip = aimed(cell.pos.x, cell.pos.y + 40);
      wTip.biobuzz!.hives.blue.tipping = 1.5;
      check(
        'shot path: a cell MID-SWING is still MADE (the aimed cell is assumed up and settled)',
        solveShotPath(wTip, wTip.robots[0]) && SHOT.made && SHOT.points >= 2,
        `tipping=${wTip.biobuzz!.hives.blue.tipping}`,
      );
    }

    // ---- THE OTHER MECHANISM: A DUMPER ---------------------------------------------------
    //
    // `solveShotPath` has two arms and everything above exercises one of them. A dumper does not
    // slew: it throws its WHOLE hopper on converging arcs and it turns the CHASSIS to aim, so its
    // "still lining up" case is a heading outside `BB_AIM_TOL` rather than a barrel off its
    // solution, and its verdict is EVERY throw landing rather than one. Same three questions as
    // the turret — made, where the drawn arc ends, where it starts — plus that gate.
    {
      /** a blue DUMPER at `(x, y)` with the chassis already ON `bbAimHeading` and three elements
       * loaded: a dumper that is lined up and ready, the only state a path is drawn in. The arc
       * drawn for a dump is the MIDDLE throw of the spread. */
      const dumper = (x: number, y: number): World => {
        const w = mkWorld('practice', 11, {
          scoreMode: 'dumper',
          shooterMount: 'back',
          bbMech: { launcher: { kind: 'dumper', mount: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
        });
        const r = w.robots[0];
        r.pos.x = x;
        r.pos.y = y;
        w.biobuzz!.hives.blue.up = 'north';
        w.biobuzz!.hives.blue.tipping = 0;
        r.hopper.push('yellow', 'yellow', 'yellow');
        // a dumper's aim IS its heading — `bbTurretSolution` returns nothing for one
        r.heading = bbAimHeading(r, bbAimTarget(w, r))!;
        return w;
      };

      // 30 in out along +y, inside a dumper's much shorter reach (the turret fixture's 40 is past
      // it — a lob is not a flywheel)
      const wd = dumper(cell.pos.x, cell.pos.y + 30);
      const dMade = solveShotPath(wd, wd.robots[0]);
      check(
        'shot path: a lined-up DUMPER in range reports MADE, with a drawable path',
        dMade && SHOT.made && SHOT.points >= 2 && SHOT.points <= SHOT_ARC_MAX,
        `made=${dMade} points=${SHOT.points} of ${SHOT_ARC_MAX}`,
      );
      const dk = (SHOT.points - 1) * 3;
      check(
        'shot path (dumper): it ENDS inside the CELL’s opening footprint, at opening height',
        Math.abs(shotArc[dk] - cell.pos.x) <= BB_CELL_OPEN.w / 2 &&
          Math.abs(shotArc[dk + 1] - cell.pos.y) <= BB_CELL_OPEN.d / 2 &&
          shotArc[dk + 2] >= BB_HIVE_OPEN_Z[0],
        `end (${shotArc[dk].toFixed(2)}, ${shotArc[dk + 1].toFixed(2)}, ${shotArc[dk + 2].toFixed(2)}) vs cell (${cell.pos.x.toFixed(2)}, ${cell.pos.y.toFixed(2)}, ${BB_HIVE_OPEN_Z[0]})`,
      );
      check(
        'shot path (dumper): the FIRST point is one tick off the LIP, not at the target',
        Math.hypot(shotArc[0] - wd.robots[0].pos.x, shotArc[1] - wd.robots[0].pos.y) < 12,
        `${shotArc[0].toFixed(2)}, ${shotArc[1].toFixed(2)}`,
      );

      // THE HEADING GATE — the dumper's own "still lining up". Stage 5b will not fire a dumper
      // whose chassis is outside `BB_AIM_TOL` of its aim heading, so a path promised for one
      // would be a promise about a shot that does not happen. 0.7 rad is well outside 0.14.
      const wd2 = dumper(cell.pos.x, cell.pos.y + 30);
      wd2.robots[0].heading += 0.7;
      check(
        'shot path: a DUMPER turned off its aim heading reports NOT MADE (nothing is drawn)',
        !solveShotPath(wd2, wd2.robots[0]) && !SHOT.made && SHOT.points === 0 && 0.7 > BB_AIM_TOL,
        `points=${SHOT.points}, tol=${BB_AIM_TOL}`,
      );

      // the same ruling as the turret — the aimed cell is assumed up — and the one negative that
      // is about RANGE: the far corner is a dump that cannot arrive at all.
      const wd3 = dumper(cell.pos.x, cell.pos.y + 30);
      wd3.biobuzz!.hives.blue.up = 'south';
      check(
        'shot path (dumper): the same dump at a cell that is DOWN is still MADE (assumed up)',
        solveShotPath(wd3, wd3.robots[0]) && SHOT.made,
      );
      const wd4 = dumper(-60, -60);
      check('shot path (dumper): from the far corner, out of a lob’s reach, reports NOT MADE', !solveShotPath(wd4, wd4.robots[0]) && !SHOT.made);
    }

    // and the buffer is never grown by a solve — the 3D line wraps it ONCE
    check(
      'shot path: the arc buffer is exactly SHOT_ARC_MAX points and is never reallocated',
      shotArc.length === SHOT_ARC_MAX * 3,
      `${shotArc.length} floats`,
    );

    // ---- WHAT EACH RENDERER ACTUALLY DRAWS (items 5 + 6) ---------------------------------
    //
    // The verdict is checked above; this is the other half of the owner's two rules — NOTHING for
    // a shot that is not made, and a DOTTED line with no end marker for one that is. The 2D half
    // is exercised through a stub context (the calls ARE the behaviour); the 3D half is a source
    // check, because a `three` import is not allowed in this lane.
    interface Op { op: string; arg?: unknown }
    const stubCtx = (ops: Op[]): CanvasRenderingContext2D => {
      const rec = (op: string) => (arg?: unknown) => { ops.push({ op, arg }); };
      return {
        save: rec('save'),
        restore: rec('restore'),
        beginPath: rec('beginPath'),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        setLineDash: rec('setLineDash'),
        stroke: rec('stroke'),
        fill: rec('fill'),
        arc: rec('arc'),
      } as unknown as CanvasRenderingContext2D;
    };
    const up = { x: 0, y: 1 };

    const madeOps: Op[] = [];
    const wm = aimed(cell.pos.x, cell.pos.y + 40);
    drawBiobuzzShotPath(stubCtx(madeOps), wm, up, 0);
    const dash = madeOps.find((o) => o.op === 'setLineDash');
    check(
      'shot path (2D): a MADE shot strokes a DOTTED polyline',
      madeOps.filter((o) => o.op === 'lineTo').length >= 1 &&
        madeOps.some((o) => o.op === 'stroke') &&
        Array.isArray(dash?.arg) &&
        (dash!.arg as number[]).length === 2 &&
        (dash!.arg as number[])[0] > 0,
      `lineTo=${madeOps.filter((o) => o.op === 'lineTo').length} dash=${JSON.stringify(dash?.arg)}`,
    );
    check(
      'shot path (2D): ...and NO end marker — the renderer draws no arc and fills nothing',
      !madeOps.some((o) => o.op === 'arc' || o.op === 'fill'),
      madeOps.map((o) => o.op).join(','),
    );

    const missOps: Op[] = [];
    const wn = aimed(cell.pos.x, cell.pos.y + 40);
    wn.robots[0].turretHeading += 0.7;
    drawBiobuzzShotPath(stubCtx(missOps), wn, up, 0);
    check(
      'shot path (2D): a shot that is NOT made draws nothing at all',
      missOps.length === 0,
      missOps.map((o) => o.op).join(','),
    );

    const spectatorOps: Op[] = [];
    drawBiobuzzShotPath(stubCtx(spectatorOps), wm, up, undefined);
    check('shot path (2D): a spectator (no local robot) draws nothing', spectatorOps.length === 0);

    // comments stripped: both greps below are for words this file's own header NAMES in order to
    // explain why they are absent
    const reticleSrc = codeLines(join(SCENE_DIR, 'renderReticle.ts')).join('\n');
    check(
      'shot path (3D): the path is a LineDashedMaterial — dotted, the same pattern the 2D map uses',
      reticleSrc.includes('LineDashedMaterial') && reticleSrc.includes('SHOT_DASH') && reticleSrc.includes('SHOT_GAP'),
    );
    check(
      'shot path (3D): the landing RING is gone, mesh and geometry both (not merely hidden)',
      !/RingGeometry|CircleGeometry/.test(reticleSrc) && !/\bring\b/i.test(reticleSrc),
    );
    check(
      'shot path (3D): the line wraps shotPath.ts’s own buffer — no per-frame allocation',
      reticleSrc.includes('new THREE.BufferAttribute(shotArc, 3)') && reticleSrc.includes('setDrawRange'),
    );
    check(
      'shot path (3D): ...and it never calls computeLineDistances(), which reallocates every frame',
      !reticleSrc.includes('computeLineDistances'),
    );
  }

  // ---- THE 3D TURRET'S YAW AND ELEVATION ARE SEPARATE NODES ------------------------------
  //
  // ⚠️ THIS SHIPPED, AND IT IS WHAT "THE SHOOTER IS NOT AIMING" LOOKED LIKE (owner playtest
  // feedback 2026-09-18, item 4). The sync set BOTH `rotation.z` (yaw) and `rotation.y`
  // (elevation) on ONE node. A `THREE.Euler`'s default order is `XYZ`, which composes as
  // `Rx·Ry·Rz`, so the elevation was applied about the UN-YAWED y axis: at a turret yaw of 160°
  // off the chassis and the 80° elevation `bbSolveShot` actually asks for at hive range, the
  // barrel came out pointing 67.7° BELOW horizontal and 44.5° off in azimuth — through the deck,
  // while the sim's own turret was dead on target. Measured, both orders, in `three` itself.
  //
  // The fix is structural rather than an Euler-order flag: yaw on `bb-turret-head`, elevation on
  // `bb-turret-pitch` UNDER it, which composes in the only order a real turret can.
  {
    const robotsSrc = readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8');
    check(
      'renderRobots.ts aims the 3D turret through SEPARATE yaw and elevation nodes',
      robotsSrc.includes('turretHeads') && robotsSrc.includes('turretPitches'),
      'a single node composes yaw and pitch in the wrong order — see this block’s comment',
    );
  }

  // ---- the four cameras, the preference, and the projection hook --------------------------
  {
    const moduleSrc = readFileSync(join(root, 'src', 'games', 'module.ts'), 'utf8');
    check(
      "SceneCamera carries all five cameras ('driver' | 'overhead' | 'chase' | 'orbit' | 'free')",
      /export type SceneCamera[^;]*'driver'[^;]*'overhead'[^;]*'chase'[^;]*'orbit'[^;]*'free'/s.test(moduleSrc),
    );
    check(
      'GameScene declares the optional project() hook (the 3D overlay’s only way to place a label)',
      /project\?\(x: number, y: number, z: number, out:/.test(moduleSrc),
    );

    const sceneSrc = readFileSync(join(SCENE_DIR, 'renderScene.ts'), 'utf8');
    check('renderScene.ts IMPLEMENTS project()', /\n {2}project\(x: number, y: number, z: number, out:/.test(sceneSrc));
    check(
      'renderScene.ts resolves the DEVICE camera preference over the frame’s camera',
      sceneSrc.includes('resolvedCamera') && sceneSrc.includes('getCameraPref'),
    );
    check(
      'renderScene.ts re-reads the backdrop on a theme change (not once at creation)',
      sceneSrc.includes("attributeFilter: ['data-theme']") && sceneSrc.includes('readBackdropColor()'),
    );

    // the 2D overlay pass must ASK the scene where a point is — the whole point of the hook
    const rendererSrc = readFileSync(join(root, 'src', 'render', 'renderer.ts'), 'utf8');
    check('Renderer takes a scene (setScene) and projects the overlay through it', typeof Renderer.prototype.setScene === 'function' && rendererSrc.includes('scene.project'));

    check(
      'the camera preference defaults to auto (no localStorage in Node ⇒ never throws)',
      getCameraPref() === 'auto',
    );
    // THE VIEW DEFAULTS TO 3D (owner, 2026-09-23), for devices that had stored '2d' too: the key
    // moved to `.v2`, so a stored `decodesim.view` no longer counts. A stored `.v2` pick still wins.
    {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.prototype.hasOwnProperty.call(g, 'localStorage');
      const prev = g.localStorage;
      const mem = new Map<string, string>();
      g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
      try {
        check('the view preference defaults to 3D with nothing stored', getViewPref() === '3d');
        mem.set('decodesim.view', '2d');
        check('a 2D pick under the old view key is ignored (everyone starts on 3D once)', VIEW_KEY !== 'decodesim.view' && getViewPref() === '3d');
        mem.set(VIEW_KEY, '2d');
        check('a 2D pick under the current view key is kept', getViewPref() === '2d');
      } finally {
        if (had) g.localStorage = prev;
        else delete g.localStorage;
      }
      check('the view preference is 3D when storage is unavailable', getViewPref() === '3d');
    }
    check(
      'every non-auto camera preference is a real SceneCamera',
      CAMERA_PREFS[0] === 'auto' &&
        CAMERA_PREFS.slice(1).every((p) => moduleSrc.includes(`'${p}'`)) &&
        CAMERA_PREFS.length === 6,
      CAMERA_PREFS.join('|'),
    );
    /**
     * A NON-INTERACTIVE SCENE IS FULLY HOST-CONTROLLED (owner report: picking Chase in the
     * replay download menu exported Driver instead). `resolveSceneCamera` is what
     * `resolvedCamera` above delegates to — an INTERACTIVE scene (the live match, a Graphics
     * preview) still defers to the device's own camera preference except when it is `'auto'`,
     * but an export or a still (`interactive: false` — `ReplayView`'s `startCapture`,
     * `Gallery.tsx`'s stills) ignores the stored preference entirely and renders exactly the
     * camera its host asked for, whatever a player last cycled to while driving.
     */
    check(
      'resolveSceneCamera: an interactive scene defers to the device pref, except auto',
      resolveSceneCamera(true, 'chase', 'driver') === 'driver' &&
        resolveSceneCamera(true, 'chase', 'auto') === 'chase' &&
        resolveSceneCamera(true, 'orbit', 'orbit') === 'orbit',
    );
    check(
      'resolveSceneCamera: a non-interactive scene (an export, a still) ignores the device pref',
      resolveSceneCamera(false, 'chase', 'driver') === 'chase' &&
        resolveSceneCamera(false, 'orbit', 'chase') === 'orbit' &&
        resolveSceneCamera(false, 'driver', 'orbit') === 'driver' &&
        // even 'auto' does not fall through to anything but the host's own pick here
        resolveSceneCamera(false, 'overhead', 'auto') === 'overhead',
    );
  }

  // ---- the HUD scrim's class is spelled the same in BOTH files ---------------------------
  //
  // A SOURCE check because the class name is the entire contract between `GameView.tsx` and
  // `styles.css`, and renaming it in one file leaves the other silently doing nothing — the HUD
  // would simply go back to its 2D styling over a lit 3D field, which looks like a design choice
  // rather than a break.
  {
    const css = readFileSync(join(root, 'src', 'ui', 'styles.css'), 'utf8');
    const view = readFileSync(join(root, 'src', 'ui', 'GameView.tsx'), 'utf8');
    check('styles.css scrims the HUD bands in the 3D view (.game-root.view-3d [data-hud-band])', css.includes('.game-root.view-3d [data-hud-band]'));
    check('GameView puts `view-3d` on .game-root when a scene canvas is live', view.includes("'game-root view-3d'"));
  }

  graphicsChecks(check, allFiles);
  hudBandChecks(check);
  environmentAndReadoutChecks(check);
  cosmeticsChecks(check);
  drawnHeightChecks(check);
  endPlateChecks(check);
  frontBackChecks(check);
  hoodPlateChecks(check);
  freeCamChecks(check);
  driverEyeChecks(check);
}

/**
 * WHICH END IS THE FRONT (owner, 2026-09-22: "somehow make it clearer fundamentally which side is
 * front and which is back in game. This is especially confusing in a symmetric robot in 3D").
 *
 * `bbFrontMarks`' header (`parts.ts`) is the design; this proves the two renderers actually draw
 * it and draw the SAME thing. The case the report is about is the one this sweeps: a `frontback`
 * sweeper with a `center` turret is mirror-symmetric, so nothing else on the robot says which way
 * it points.
 *
 * ⚠️ IT ASSERTS THE MARKS ARE NOT COLLIDERS, the same way `endPlateChecks` does: they sit inside
 * the chassis box in x/y and only stand above the deck, so neither solve grows for them.
 *
 * ⚠️ AND IT ASSERTS THERE IS NO AMBER ANYWHERE ON THE ROBOT (owner, 2026-09-22: "what is this ugly
 * ass yellow and black beams rendered in 3D? It is awful and does not fit FTC"). The rear's
 * hazard stripes are gone; this is the check that keeps them gone, in both renderers and in the
 * shared geometry, rather than trusting that nobody re-adds a "clearer" version of them.
 */
function frontBackChecks(check: Check): void {
  const ID = 5;
  const SYMMETRIC = { intakeMount: 'frontback', drivetrain: 'mecanum' } as const;
  const ALLIANCE_INKS = ['#ef4444', '#3b82f6', '#007be1'];

  check(
    'front/back: the marks are neither alliance colour — "red end" must not compete with "red team"',
    !ALLIANCE_INKS.includes(BB_FRONT_INK.toLowerCase()) && !ALLIANCE_INKS.includes(BB_REAR_INK.toLowerCase()),
    `${BB_FRONT_INK} / ${BB_REAR_INK}`,
  );
  // NO HAZARD STRIPES, in either renderer or in the geometry they share. `#f59e0b` is the exact
  // amber that shipped for four hours; the wider net catches a differently-spelled retry.
  {
    const srcs: [string, string][] = [
      ['parts.ts', readFileSync(join(BIOBUZZ_DIR, 'parts.ts'), 'utf8')],
      ['drawRobot.ts', readFileSync(join(BIOBUZZ_DIR, 'drawRobot.ts'), 'utf8')],
      ['scene/renderRobots.ts', readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8')],
    ];
    for (const [name, src] of srcs) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // AMBER by what it IS, not by one literal: a hot red channel, a middling green and almost
      // no blue. Spelling the family out catches a retry at a different hex; matching `#f5...`
      // would have caught plain white too.
      const hits = [...code.matchAll(/#[0-9a-f]{6}\b/gi)]
        .map((m) => m[0])
        .filter((hex) => {
          const n = parseInt(hex.slice(1), 16);
          const [rr, gg, bb2] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
          return rr >= 0xc8 && gg >= 0x50 && gg <= 0xc8 && bb2 <= 0x60;
        });
      check(
        `front/back: ${name} names no amber/hazard colour — the rear is structure, not a warning label`,
        hits.length === 0 && !/BB_HAZARD|:hazard/i.test(code),
        hits.join(', ') || 'clean',
      );
    }
  }

  // ---- 3D: the nodes exist, they are on the ends they name, and they grow nothing -----------
  for (const [L, W] of [[13.5, 13.5], [18, 18], [17.5, 13.5]] as const) {
    for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
      const spec: RobotSpec = { ...BB_DEFAULT_SPEC, ...SYMMETRIC, intakeMount: mount, length: L, width: W };
      const tag = `${L}x${W}/${mount}`;
      const nodes = buildFrontMarks(spec, ID);
      for (const n of nodes) n.updateMatrixWorld(true);
      const names = nodes.map((n) => n.name).sort();
      check(
        `front/back 3D ${tag}: exactly the three mark nodes exist — no legacy nose box, no hazard ribs`,
        JSON.stringify(names) ===
          JSON.stringify([`robot:${ID}:front:arrow`, `robot:${ID}:front:bar`, `robot:${ID}:rear:bar`]),
        names.join(','),
      );

      const boxOf = (name: string) => {
        const n = nodes.find((x) => x.name === `robot:${ID}:${name}`);
        return n ? new THREE.Box3().setFromObject(n) : null;
      };
      const front = boxOf('front:bar');
      const rear = boxOf('rear:bar');
      const arrow = boxOf('front:arrow');
      if (!front || !rear || !arrow) continue;

      const hl = L / 2;
      check(
        `front/back 3D ${tag}: the light bar is at +x and flush with the front rail`,
        front.min.x > 0 && Math.abs(front.max.x - hl) < 1e-6,
        `x[${front.min.x.toFixed(3)}, ${front.max.x.toFixed(3)}] vs hl ${hl}`,
      );
      check(
        `front/back 3D ${tag}: the rear rail is at −x and flush with the rear rail`,
        rear.max.x < 0 && Math.abs(rear.min.x + hl) < 1e-6,
        `x[${rear.min.x.toFixed(3)}, ${rear.max.x.toFixed(3)}]`,
      );
      // FULL WIDTH is the property that survives occlusion — a mark narrow enough to hide behind
      // a turret is the nose box this replaced.
      for (const [name, b] of [['light bar', front], ['rear rail', rear]] as const) {
        check(
          `front/back 3D ${tag}: the ${name} spans most of the chassis width`,
          b.max.y - b.min.y >= W - 2 * BB_END_BAR_INSET - 1e-6,
          `${(b.max.y - b.min.y).toFixed(2)} in of ${W}`,
        );
      }
      check(
        `front/back 3D ${tag}: the deck arrow POINTS FORWARD — apex ahead of its own base`,
        arrow.max.x > arrow.min.x && Math.abs(arrow.max.x - bbFrontMarks(spec).arrow.apex) < 1e-6,
        `x[${arrow.min.x.toFixed(3)}, ${arrow.max.x.toFixed(3)}]`,
      );
      // NOT A COLLIDER — inside the frame box both solves already treat as solid, and above the
      // deck. Same ruling as the end plates.
      const frame3d = chassis3dShapes(spec, BB3_HEIGHT_DEFAULT)[0];
      for (const n of nodes) {
        const b = new THREE.Box3().setFromObject(n);
        check(
          `front/back 3D ${tag}: ${n.name} stays inside the chassis compound's own frame box`,
          b.min.x >= -frame3d.hx - 1e-6 && b.max.x <= frame3d.hx + 1e-6 &&
            b.min.y >= -frame3d.hy - 1e-6 && b.max.y <= frame3d.hy + 1e-6 &&
            b.min.z >= BB_DECK_Z - 1e-6 && b.max.z <= BB3_HEIGHT_DEFAULT + 1e-6,
          `x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}]`,
        );
      }
    }
  }
  check(
    'front/back 3D: the light bar is EMISSIVE — a matte white bar goes grey in the hive’s shadow',
    /emissive: BB_FRONT_INK,/.test(readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8')),
  );
  check(
    'front/back 3D: the 0.7-in nose box is GONE (it is what the report was about)',
    !/robot:\$\{id\}:nose/.test(readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8')),
  );

  // ---- 2D: the sprite hits a recording context with the same three marks --------------------
  //
  // A permissive recording ctx, the `strokesOf` technique one block down: every call is a no-op,
  // and what is kept is the `fillStyle` in force at each `fillRect`, plus the path the one filled
  // TRIANGLE is built from.
  {
    type Rect = { style: string; x: number; y: number; w: number; h: number };
    const record = (draw: (c: CanvasRenderingContext2D) => void): { rects: Rect[]; tris: { style: string; pts: number[][] }[] } => {
      const rects: Rect[] = [];
      const tris: { style: string; pts: number[][] }[] = [];
      let style = '';
      let pts: number[][] = [];
      const sink: unknown = new Proxy(function () {}, { get: () => sink, apply: () => sink });
      const ctx = new Proxy(
        {},
        {
          get: (_t, k) => {
            if (k === 'fillStyle') return style;
            if (k === 'fillRect') return (x: number, y: number, w: number, h: number) => { rects.push({ style: String(style).toLowerCase(), x, y, w, h }); };
            if (k === 'beginPath') return () => { pts = []; };
            if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => { pts.push([x, y]); };
            if (k === 'fill') return () => { if (pts.length === 3) tris.push({ style: String(style).toLowerCase(), pts: pts.slice() }); };
            return sink;
          },
          set: (_t, k, v) => {
            if (k === 'fillStyle') style = v;
            return true;
          },
        },
      ) as unknown as CanvasRenderingContext2D;
      draw(ctx);
      return { rects, tris };
    };

    for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
      const world = createBiobuzzWorld('free', 5, [
        { id: 0, alliance: 'red', spec: { ...BB_DEFAULT_SPEC, ...SYMMETRIC, intakeMount: mount } as RobotSpec, assists: {} as never, startIndex: 0 },
      ]);
      const r = world.robots[0];
      const m = bbFrontMarks(r.spec);
      const { rects, tris } = record((c) => drawBiobuzzRobot(c, r, false, [], { x: 0, y: 1 }, world));
      const ink = BB_FRONT_INK.toLowerCase();

      const bar = rects.find((q) => q.style === ink && Math.abs(q.x - m.front.x0) < 1e-6 && Math.abs(q.w - (m.front.x1 - m.front.x0)) < 1e-6);
      check(`front/back 2D ${mount}: the light bar is filled at the FRONT rail, full width`, !!bar && bar.x > 0 && Math.abs(bar.h - m.front.halfY * 2) < 1e-6, bar ? `x ${bar.x.toFixed(2)} w ${bar.w.toFixed(2)} h ${bar.h.toFixed(2)}` : 'no such rect');

      check(
        `front/back 2D ${mount}: a plain rail at the REAR, in the chassis' own dark and with no stripes`,
        rects.some((q) => q.style === BB_REAR_INK.toLowerCase() && Math.abs(q.x + r.spec.length / 2) < 1e-6) &&
          rects.filter((q) => q.style === BB_REAR_INK.toLowerCase()).length === 1,
        `${rects.filter((q) => q.style === BB_REAR_INK.toLowerCase()).length} rear fills`,
      );

      const arrow = tris.find((t) => t.style === ink);
      check(
        `front/back 2D ${mount}: the deck arrow is filled, and its apex points at the light bar`,
        !!arrow && Math.abs(arrow.pts[0][0] - m.arrow.apex) < 1e-6 && arrow.pts[0][1] === 0 &&
          arrow.pts[1][0] < arrow.pts[0][0] && arrow.pts[2][0] < arrow.pts[0][0],
        arrow ? `apex ${arrow.pts[0][0].toFixed(2)} base ${arrow.pts[1][0].toFixed(2)}` : 'no filled triangle in the front ink',
      );
      check(
        `front/back 2D ${mount}: no mark is filled in an alliance colour, and nothing is filled amber`,
        !rects.some((q) => ALLIANCE_INKS.includes(q.style)) && !tris.some((t) => ALLIANCE_INKS.includes(t.style)) &&
          !rects.some((q) => /^#f[0-9a-f]{2}[0-9a-f]{3}$/.test(q.style) && q.style !== BB_FRONT_INK.toLowerCase()),
      );
    }
  }
}

/**
 * THE DRAWN HEIGHT PROFILE (owner, 2026-09-21, the sixth invisible-corner report) — the
 * agreement between what `renderRobots.ts` BUILDS and the numbers `sim3d/` extrudes its chassis
 * compound to (`BB3_CHASSIS_TOP_Z`, `BB3_TURRET_R`, `BB3_TURRET_TOP_Z`, `config.ts`).
 *
 * ⚠️ **IT HAS TO BE A CHECK AND NOT AN IMPORT.** `sim3d/` may not import `scene/` (the lazy-chunk
 * boundary this lane enforces a few hundred lines up), so the physics side carries its own copy
 * of the drawn robot's heights — the same bargain `BB_PLATE_T_DUP` makes for the ramp rails'
 * inboard offset. What makes the copy safe is this: the meshes are BUILT here and measured off
 * their own vertices, so a picture that grows taller than the collider fails immediately.
 *
 * `buildFrame`/`buildIntake`/`buildTurret` are DOM-free and are called directly, the same bargain
 * `cosmeticsChecks` makes; `buildRobotGroup` needs a canvas and is not called here. The DUMPER's
 * own envelope (`BB3_DUMPER_*`) is not reachable — `buildDumper` is not exported — and is pinned
 * by `scratch/mechenv.ts`'s measurement instead, which reproduces every one of its numbers from
 * `mounts.ts` to 0.01 in.
 */
function drawnHeightChecks(check: Check): void {
  /**
   * ⚠️ **THE RAMP'S OWN PARTS ARE SKIPPED, AND THAT IS NOT A CONVENIENCE.** A FOLDED ramp stands
   * its rails and blade up round the barrel to 11.39 in — drawn hardware that the collider gives
   * nothing at all, because a folded ramp is not solid to anything (`chassis3dReachShapes`
   * returns an empty list until `rampReady`). That predates the height profile and is the
   * harmless direction (drawn outside the collider); what this function bounds is the LOW BODY,
   * and the ramp's SETTLED shapes are the reach hardware's own business.
   */
  const RAMP_PART = /^robot:ramp:/;
  const zMax = (nodes: THREE.Object3D[]): number => {
    let z = -Infinity;
    const v = new THREE.Vector3();
    for (const n of nodes) {
      if (RAMP_PART.test(n.name)) continue;
      n.updateWorldMatrix(true, true);
      n.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!(m as { isMesh?: boolean }).isMesh) return;
        if (RAMP_PART.test(o.name) || RAMP_PART.test(o.parent?.name ?? '')) return;
        const pos = m.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
          if (v.z > z) z = v.z;
        }
      });
    }
    return z;
  };

  // ---- the LOW BODY: the frame and the intake assembly both sit under `BB3_CHASSIS_TOP_Z` ----
  {
    let worst = -Infinity;
    let where = '';
    for (const mount of ['front', 'back', 'side', 'frontback'] as const)
      for (const kind of ['sweeper', 'siderollers', 'ramp'] as const) {
        const spec = bbCoerce({
          ...BB_DEFAULT_SPEC,
          intakeMount: mount,
          bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null, intake: { kind } },
        });
        const z = Math.max(zMax(buildFrame(spec)), zMax(buildIntake(spec).nodes));
        if (z > worst) {
          worst = z;
          where = `${kind}@${mount}`;
        }
      }
    check(
      `drawn height: the frame and every intake archetype stay under BB3_CHASSIS_TOP_Z (${BB3_CHASSIS_TOP_Z}) — the height the 3D low body is built to`,
      worst <= BB3_CHASSIS_TOP_Z && worst > BB3_CHASSIS_TOP_Z - 0.2,
      `tallest drawn chassis part ${worst.toFixed(3)} in (${where})`,
    );
  }

  // ---- the TURRET: its drawn top and the radius it sweeps about its own ring -----------------
  //
  // ⚠️ A RADIUS, NOT A BOX, because the head YAWS and the collider is built once — the disc it
  // sweeps is its drawn geometry (`bbMechEnvelopes`' own header). Neither figure scales with the
  // chassis: the head is built from `BB_FLYWHEEL_R` and the hood constants.
  {
    const worst: Record<0 | 1, { z: number; r: number }> = { 0: { z: -Infinity, r: 0 }, 1: { z: -Infinity, r: 0 } };
    const v = new THREE.Vector3();
    for (const mount of BB_MOUNT_POSITIONS)
      for (const which of [0, 1] as const)
        for (const [l, w] of [[13.5, 14.5], [15, 17], [17, 18]] as const) {
          const spec = bbCoerce({ ...BB_DEFAULT_SPEC, length: l, width: w });
          const head = buildTurret(spec, mount, which);
          head.updateWorldMatrix(true, true);
          const c = turretLocal(spec, mount);
          head.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!(m as { isMesh?: boolean }).isMesh) return;
            const pos = m.geometry.getAttribute('position');
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
              worst[which].z = Math.max(worst[which].z, v.z);
              worst[which].r = Math.max(worst[which].r, Math.hypot(v.x - c.x, v.y - c.y));
            }
          });
        }
    for (const [which, label, rc, zc] of [
      [0, 'POLLEN', BB3_TURRET_R, BB3_TURRET_TOP_Z],
      [1, 'NECTAR', BB3_NECTAR_TURRET_R, BB3_NECTAR_TURRET_TOP_Z],
    ] as const) {
      const got = worst[which];
      check(
        `drawn height: the ${label} turret head fits its own collider cylinder (r ${rc}, top ${zc}) at every mount and chassis size`,
        got.z <= zc && got.r <= rc && got.z > zc - 0.2 && got.r > rc - 0.2,
        `drawn top ${got.z.toFixed(3)} r ${got.r.toFixed(3)}`,
      );
    }
  }
}

/**
 * COSMETICS (Day 4, `docs/cosmetics-plan.md` §3.4) — accent/decal/plate render identically in
 * both the 2D sprites and this scene. `buildIntake`/`buildTurret`/`buildSwervePod` are DOM-free
 * (no canvas texture on the paths this touches), so they are exercised directly, the same
 * bargain the rest of Lane B makes; `buildRobotGroup` itself needs a DOM canvas (the sign/decal
 * textures) and stays untested here, same as before this feature existed. Every new `accent`
 * parameter defaults to a no-op (the part's own base colour), so a call with no argument is the
 * REGRESSION check: the exact pixel a build had before cosmetics landed.
 */
function cosmeticsChecks(check: Check): void {
  // `RobotSpec.accent`/`decal`/`plate` are landing on a parallel lane; build fixtures
  // structurally rather than waiting on the type (`CLAUDE.md`'s note on this file's scope).
  const withCosm = (extra: { accent?: string; decal?: string; plate?: string }): RobotSpec =>
    ({ ...BB_DEFAULT_SPEC, ...extra }) as unknown as RobotSpec;

  // ---- bbSpecKey: the rebuild key moves on every axis, and is unchanged for none of them -----
  {
    const base = bbSpecKey(BB_DEFAULT_SPEC);
    check('bbSpecKey is unchanged for a spec with none of the three cosmetics set (no regression)', bbSpecKey(BB_DEFAULT_SPEC) === base);
    check('bbSpecKey changes when accent changes', bbSpecKey(withCosm({ accent: 'red' })) !== base);
    check('bbSpecKey changes when decal changes', bbSpecKey(withCosm({ decal: 'stripe' })) !== base);
    check('bbSpecKey changes when plate changes', bbSpecKey(withCosm({ plate: 'bold' })) !== base);
  }

  // ---- buildIntake: the roller hub tints with the accent; a default (no argument) call is a
  // byte-for-byte no-op against the SWEEPER colour every build had before cosmetics -------------
  {
    const hubHex = (accent?: string): string | undefined => {
      const built = accent === undefined ? buildIntake(BB_DEFAULT_SPEC) : buildIntake(BB_DEFAULT_SPEC, accent);
      let roll: THREE.Object3D | undefined;
      for (const n of built.nodes) n.traverse((o) => { if (o.name.startsWith('robot:sweeper:')) roll = o; });
      const mesh = roll?.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh | undefined;
      return (mesh?.material as THREE.MeshStandardMaterial | undefined)?.color.getHexString();
    };
    const bare = hubHex();
    check('buildIntake with no accent argument keeps the roller hub at bare SWEEPER (no regression)', bare === '12161c', String(bare));
    const tinted = hubHex('#ff0000');
    check('buildIntake WITH an accent tints the roller hub away from bare SWEEPER', tinted !== undefined && tinted !== '12161c', String(tinted));
  }

  // ---- buildTurret: THE FLYWHEEL IS BLACK, AND NO ACCENT REACHES IT ---------------------------
  //
  // ⚠️ THIS PAIR SAID THE OPPOSITE FOR ONE DAY. The 2026-09-20 cosmetics pass tinted the tyre and
  // these checks asserted the tint; the owner reversed it on 2026-09-21 ("keep the flywheel
  // black"), so `buildTurret` has no `accent` parameter at all any more — a dead one would be the
  // next pass's temptation to re-wire it. What is left is the fact, measured off the material the
  // mesh actually carries, under three different accents rather than one.
  {
    const flywheelHex = (): string | undefined => {
      const t = buildTurret(BB_DEFAULT_SPEC, 'center');
      let mesh: THREE.Mesh | undefined;
      t.traverse((o) => {
        if (o.name === 'bb-turret-flywheel') mesh = o as THREE.Mesh;
      });
      return (mesh?.material as THREE.MeshStandardMaterial | undefined)?.color.getHexString();
    };
    check('buildTurret keeps the flywheel at bare SWEEPER black', flywheelHex() === '12161c', String(flywheelHex()));
    check(
      'buildTurret takes NO accent argument — the cosmetic cannot reach the flywheel from anywhere',
      /export function buildTurret\(spec: RobotSpec, mountPos: BbMountPos, which: 0 \| 1 = 0\): THREE\.Group/.test(
        readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderRobots.ts'), 'utf8'),
      ),
    );
    const robotsSrc = readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderRobots.ts'), 'utf8');
    check(
      '...and the wheel mesh is built on a FLAT SWEEPER, not a tint3d of it',
      robotsSrc.includes('wheelGeometry(BB_FLYWHEEL_R, fwW), solidMat(SWEEPER, 0.45, 0.2)'),
    );
    // the 2D sprites make the same promise, in both games — one `drawRoller` call each, and the
    // accent is not what they hand it
    for (const [game, file] of [
      ['biobuzz', join(root, 'src', 'games', 'biobuzz', 'drawRobot.ts')],
      ['chain', join(root, 'src', 'games', 'chain', 'drawRobot.ts')],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      check(
        `${game}'s 2D turret draws its flywheel on RUBBER_HI, never the cosmetic accent`,
        src.includes('drawRoller(ctx, 0, gap / 2 - 0.35, 1.5, live, RUBBER_HI, 1.2)') ||
          src.includes('drawRoller(ctx, 0, gap / 2 - 0.35, 1.5, loaded, RUBBER_HI, 1.2)'),
      );
    }
  }

  // ---- buildSwervePod: the tyre tints with the accent; default is the same no-op -------------
  {
    // ⚠️ `bb-pod-wheel` IS A GROUP NOW (2026-09-21): the pod carries a real goBILDA 72 mm Hogback
    // — a crowned rubber band on a plastic core, two meshes — so the RUBBER one inside it is what
    // the accent tints, and the core is steel and must not be.
    const tyreHex = (accent?: string): string | undefined => {
      const pod = accent === undefined ? buildSwervePod() : buildSwervePod(accent);
      let mesh: THREE.Mesh | undefined;
      pod.traverse((o) => {
        if (o.name === 'bb-wheel-tread') mesh = o as THREE.Mesh;
      });
      return (mesh?.material as THREE.MeshStandardMaterial | undefined)?.color.getHexString();
    };
    const bare = tyreHex();
    check('buildSwervePod with no accent argument builds (a bare TREAD tyre) -- no regression', bare !== undefined, String(bare));
    const tinted = tyreHex('#22c55e');
    check('buildSwervePod WITH an accent tints the tyre away from the bare build', tinted !== undefined && tinted !== bare, String(tinted));
  }

  // ---- 2D: the halo ring and the decal path, against a stub context (the tape probe's own
  // technique above) -- proves a default-cosmetic sprite issues the halo and no decal path -----
  {
    let strokeStyle = '';
    let strokeCount = 0;
    let fillCount = 0;
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      closePath() {},
      clip() {},
      rect() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      arcTo() {},
      fillRect() {
        fillCount++;
      },
      strokeRect() {},
      fill() {
        fillCount++;
      },
      stroke() {
        strokeCount++;
      },
      set strokeStyle(v: string) {
        strokeStyle = v;
      },
      get strokeStyle() {
        return strokeStyle;
      },
      set fillStyle(_v: string) {},
      set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;

    fillCount = 0;
    drawDecal(ctx, 8, 6, 'none', '#ff0000');
    check('a default-cosmetic sprite (decal "none") issues NO decal drawing', fillCount === 0, String(fillCount));

    fillCount = 0;
    drawDecal(ctx, 8, 6, 'stripe', '#ff0000');
    check('a "stripe" decal issues at least one fill', fillCount > 0, String(fillCount));

    fillCount = 0;
    drawDecal(ctx, 8, 6, 'star', '#ff0000');
    check('a "star" decal issues at least one fill (the earned key draws too, not just the shipped tier ones)', fillCount > 0, String(fillCount));

    void strokeCount;
    void strokeStyle;
  }

  // ---- star decal: PARAMETRIC in the footprint, sized off the SMALLER half-dimension ---------
  // (`docs/cosmetics-plan.md` §4's named risk — a decal must scale to any legal chassis).
  // Traces the actual vertices `drawDecal`'s `'star'` case emits on two very different
  // footprints: a near-square one and a long, narrow one this sim's legal chassis range
  // actually spans. A per-axis scale (hl one way, hw the other — fine for `chevron`, an
  // arrow with no rotational symmetry to protect) would squash a 5-fold-symmetric star into
  // an ellipse on the narrow chassis; sizing off `Math.min(hl, hw)` is what a REAL star, not
  // a lookalike, requires.
  {
    const trace = (hl: number, hw: number): { xs: number[]; ys: number[] } => {
      const xs: number[] = [];
      const ys: number[] = [];
      const ctx = {
        save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, rect() {},
        moveTo(x: number, y: number) { xs.push(x); ys.push(y); },
        lineTo(x: number, y: number) { xs.push(x); ys.push(y); },
        arc() {}, arcTo() {}, fillRect() {}, strokeRect() {}, fill() {}, stroke() {},
        set strokeStyle(_v: string) {}, get strokeStyle() { return ''; },
        set fillStyle(_v: string) {}, set lineWidth(_v: number) {},
      } as unknown as CanvasRenderingContext2D;
      drawDecal(ctx, hl, hw, 'star', '#ff0000');
      return { xs, ys };
    };
    // `starPoints` alternates outer/inner starting on an outer vertex, and `drawDecal` traces
    // it in that order untouched — so the recorded points do too: even index = outer, odd = inner.
    const radii = (t: { xs: number[]; ys: number[] }) => t.xs.map((x, i) => Math.hypot(x, t.ys[i]));
    const outerRadii = (t: { xs: number[]; ys: number[] }) => radii(t).filter((_, i) => i % 2 === 0);
    const spread = (ns: number[]) => Math.max(...ns) - Math.min(...ns);

    const square = trace(8, 8); // hl === hw: min-dimension and either dimension agree
    const narrow = trace(20, 3); // a long, narrow chassis: hw is the binding dimension

    check(
      'star decal: outer radius is 0.8× the SMALLER half-dimension, on both a square and a long/narrow footprint',
      Math.abs(Math.max(...outerRadii(square)) - 8 * 0.8) < 0.01 && Math.abs(Math.max(...outerRadii(narrow)) - 3 * 0.8) < 0.01,
      `square r=${Math.max(...outerRadii(square)).toFixed(3)} (want ${(8 * 0.8).toFixed(3)}), narrow r=${Math.max(...outerRadii(narrow)).toFixed(3)} (want ${(3 * 0.8).toFixed(3)})`,
    );
    check(
      'star decal: two very different footprints scale PROPORTIONALLY (not the same absolute size)',
      Math.abs(Math.max(...outerRadii(square)) - Math.max(...outerRadii(narrow))) > 1,
      `square r=${Math.max(...outerRadii(square)).toFixed(3)}, narrow r=${Math.max(...outerRadii(narrow)).toFixed(3)}`,
    );
    // A per-axis (x one scale, y another) distortion would spread the five OUTER vertices'
    // radii apart from each other, because they sit at five different angles (0/72/144/216/288)
    // and an anisotropic scale moves each by a different amount. `Math.hypot` on each recorded
    // vertex, on the LONG/NARROW footprint where a bug would show up worst, is what a bounding-
    // box aspect ratio can't tell you: a regular 5-point star's bbox is legitimately not square
    // (~0.951 pointing on-axis, arithmetic in the header of `starPoints`) even when the star
    // itself is perfectly regular, which is what tripped this check up on the first pass.
    check(
      'star decal: all five OUTER vertices sit at the SAME radius on the long/narrow footprint — a real star, not an ellipse',
      spread(outerRadii(narrow)) < 1e-9,
      `outer radii spread=${spread(outerRadii(narrow)).toExponential(2)}`,
    );
  }

  // ---- the OTHER two draw sites must handle "star" too — a silent fallthrough (nothing drawn,
  // nothing thrown) is exactly how this would ship broken, so these are read off the SOURCE:
  // `getDecalTexture` needs a DOM canvas this DOM-free lane deliberately does not stub (see this
  // function's own comment above `buildRobotGroup`), and `decalShape` returns a React element
  // this lane has no renderer for — grepping the switch body is what the sign/plate checks in
  // this file already do for the same reason (`buildDumper`, `buildTurret`'s no-accent contract).
  {
    const robotsSrc = readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderRobots.ts'), 'utf8');
    const from = robotsSrc.indexOf('function getDecalTexture(');
    const to = robotsSrc.indexOf('\nconst PLATE_SILVER', from);
    const body = from > 0 ? robotsSrc.slice(from, to > from ? to : undefined) : '';
    check(
      '3D decal texture: getDecalTexture HANDLES "star" (a real case, not a silent fallthrough)',
      from > 0 && to > from && /case 'star':/.test(body) && /starPoints\(/.test(body) && /ctx\.fill\(\)/.test(body),
      `${body.length} chars scanned`,
    );
    check(
      '3D decal texture: the star case sizes off Math.min(hw, hh) — this canvas’s own isotropic half-extents — matching the 2D 0.8× radius exactly',
      /Math\.min\(hw,\s*hh\)\s*\*\s*0\.8/.test(body),
    );

    const menuSrc = readFileSync(join(root, 'src', 'ui', 'Menu.tsx'), 'utf8');
    const mFrom = menuSrc.indexOf('function decalShape(');
    const mTo = menuSrc.indexOf('\nfunction plateShape(', mFrom);
    const mBody = mFrom > 0 ? menuSrc.slice(mFrom, mTo > mFrom ? mTo : undefined) : '';
    check(
      'builder swatch: decalShape HANDLES "star" (else the swatch silently renders nothing, and nobody notices)',
      mFrom > 0 && mTo > mFrom && /case 'star':/.test(mBody) && /starPoints\(/.test(mBody) && /<path/.test(mBody),
      `${mBody.length} chars scanned`,
    );
  }

  // ---- NO SPRITE STROKES IN AN ALLIANCE COLOUR (owner, 2026-09-21: "Remove the red/blue alliance
  // outline") — all three games, both alliances, intake on and off. A permissive recording ctx:
  // every call is a no-op, and the `strokeStyle` in force at each stroke is what is kept.
  {
    const strokesOf = (draw: (ctx: CanvasRenderingContext2D) => void): string[] => {
      const seen: string[] = [];
      let style = '';
      const sink: unknown = new Proxy(function () {}, { get: () => sink, apply: () => sink });
      const ctx = new Proxy(
        {},
        {
          get: (_t, k) => {
            if (k === 'strokeStyle') return style;
            if (k === 'stroke' || k === 'strokeRect') return () => { seen.push(String(style).toLowerCase()); };
            return sink;
          },
          set: (_t, k, v) => {
            if (k === 'strokeStyle') style = v;
            return true;
          },
        },
      ) as unknown as CanvasRenderingContext2D;
      draw(ctx);
      return seen;
    };
    const ALLIANCE = ['#ef4444', '#3b82f6', '#007be1'];
    const seat = (a: 'red' | 'blue') => ({ id: 0, alliance: a, spec: {} as RobotSpec, assists: {} as never, startIndex: 0 });
    for (const a of ['red', 'blue'] as const) {
      const worlds = {
        decode: createDecodeWorld('free', 5, [seat(a)]),
        chain: createChainWorld('free', 5, [seat(a)]),
        biobuzz: createBiobuzzWorld('free', 5, [seat(a)]),
      };
      const draws = {
        decode: (c: CanvasRenderingContext2D, on: boolean) => drawDecodeRobot(c, worlds.decode.robots[0], on, []),
        chain: (c: CanvasRenderingContext2D, on: boolean) => drawChainRobot(c, worlds.chain.robots[0], on, [], { x: 0, y: 1 }, worlds.chain),
        biobuzz: (c: CanvasRenderingContext2D, on: boolean) => drawBiobuzzRobot(c, worlds.biobuzz.robots[0], on, [], { x: 0, y: 1 }, worlds.biobuzz),
      };
      for (const game of ['decode', 'chain', 'biobuzz'] as const) {
        const strokes = [...strokesOf((c) => draws[game](c, false)), ...strokesOf((c) => draws[game](c, true))];
        const bad = strokes.filter((st) => ALLIANCE.includes(st));
        check(
          `2D (${game}, ${a}): the sprite strokes NOTHING in an alliance colour, and its edge is the neutral trim`,
          strokes.length > 0 && bad.length === 0 && strokes.includes(ROBOT_TRIM),
          `${strokes.length} strokes, ${bad.length} alliance-coloured, trim used ${strokes.filter((st) => st === ROBOT_TRIM).length}×`,
        );
      }
    }
  }
}

/**
 * END PLATES (owner, 2026-09-20: "cover up the back of the chassis with a full back plate, and
 * cover up the front with two small plates just to hide the wheels"). `buildEndPlates`'s own
 * header in `renderRobots.ts` carries the geometry; this proves the RESULT — the right nodes
 * exist and only those, every plate's bbox stays inside the chassis footprint BOTH solves already
 * treat as solid (the 3D compound's frame box and the 2D artifact solve's chassis rect — NEITHER
 * grows for these, per the owner's "they should be part of the collider... prove it instead"
 * ruling), a corner plate actually covers the wheel or pod it exists to hide, and nothing crosses
 * the mouth's own throat below the slot an element rolls in under.
 */
function endPlateChecks(check: Check): void {
  const MOUNTS = ['front', 'back', 'side', 'frontback'] as const;
  const DRIVETRAINS = ['mecanum', 'swerve', 'tank'] as const;
  const ID = 7;

  for (const mount of MOUNTS) {
    for (const dt of DRIVETRAINS) {
      const spec: RobotSpec = { ...BB_DEFAULT_SPEC, intakeMount: mount, drivetrain: dt };
      const tag = `${mount}/${dt}`;
      const nodes = buildEndPlates(spec, ID);
      for (const n of nodes) n.updateMatrixWorld(true);

      // ---- exactly the expected nodes, and only those --------------------------------------
      const names = nodes.map((n) => n.name).sort();
      const expected = (
        mount === 'side'
          ? [`robot:${ID}:endplate:back`, `robot:${ID}:endplate:front`]
          : mount === 'frontback'
            ? [`robot:${ID}:endplate:back:l`, `robot:${ID}:endplate:back:r`, `robot:${ID}:endplate:front:l`, `robot:${ID}:endplate:front:r`]
            : mount === 'front'
              ? [`robot:${ID}:endplate:back`, `robot:${ID}:endplate:front:l`, `robot:${ID}:endplate:front:r`]
              : [`robot:${ID}:endplate:back:l`, `robot:${ID}:endplate:back:r`, `robot:${ID}:endplate:front`]
      ).sort();
      check(`endplate/${tag}: exactly the expected plate nodes exist, and only those`, JSON.stringify(names) === JSON.stringify(expected), names.join(','));

      // ---- containment: NOT a collider (owner ruling) — every plate must sit inside the boxes
      // the chassis compound and the 2D solve already treat as solid, never grow them ------------
      const hl = spec.length / 2;
      const frame3d = chassis3dShapes(spec, BB3_HEIGHT_DEFAULT)[0]; // {cx:0,cy:0,hx:hl,hy:hw,...}
      const chassis2d = bbRobotSolids({ spec } as unknown as RobotState, []).chassis;
      for (const n of nodes) {
        const box = new THREE.Box3().setFromObject(n);
        const in3d =
          box.min.x >= -frame3d.hx - 1e-6 && box.max.x <= frame3d.hx + 1e-6 &&
          box.min.y >= -frame3d.hy - 1e-6 && box.max.y <= frame3d.hy + 1e-6 &&
          box.min.z >= -1e-6 && box.max.z <= BB3_HEIGHT_DEFAULT + 1e-6;
        check(
          `endplate/${tag}: ${n.name} sits inside the 3D chassis compound's own frame box (no collider of its own needed)`,
          in3d,
          `x[${box.min.x.toFixed(3)},${box.max.x.toFixed(3)}] y[${box.min.y.toFixed(3)},${box.max.y.toFixed(3)}] z[${box.min.z.toFixed(3)},${box.max.z.toFixed(3)}] vs hx=${frame3d.hx} hy=${frame3d.hy}`,
        );
        const in2d =
          box.min.x >= chassis2d.cx - chassis2d.hx - 1e-6 && box.max.x <= chassis2d.cx + chassis2d.hx + 1e-6 &&
          box.min.y >= chassis2d.cy - chassis2d.hy - 1e-6 && box.max.y <= chassis2d.cy + chassis2d.hy + 1e-6;
        check(`endplate/${tag}: ${n.name} sits inside bbRobotSolids' 2D chassis rect in x/y`, in2d);

        const outward = n.name.includes(':front') ? box.max.x : box.min.x;
        const target = n.name.includes(':front') ? hl : -hl;
        check(`endplate/${tag}: ${n.name}'s outer face is flush with the chassis end, never past it`, Math.abs(outward - target) < 1e-6, `${outward.toFixed(6)} vs ${target}`);
      }
    }
  }

  // ---- a corner plate actually covers the wheel/pod `buildWheels` puts at that corner --------
  //
  // ⚠️ **EVERY DRIVETRAIN IS BUILT FOR REAL IN THIS LANE NOW**, and the paragraph that used to be
  // here — "tank is built for real, mecanum is not, because the roller stripe texture calls
  // `document.createElement`" — is obsolete in the best way. The stripe texture is gone (owner,
  // 2026-09-21); a wheel is merged `LatheGeometry`/`ExtrudeGeometry`/`BoxGeometry` and needs no
  // DOM at all, so `buildWheels` can be CALLED for mecanum, X-drive and butterfly here instead of
  // having its placement line grepped as a stand-in. The two source checks below shrink to the one
  // claim a measurement cannot make: that both halves still come off ONE expression.
  {
    const robotsCode = readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderRobots.ts'), 'utf8');
    check(
      'endplate-cover/source: every non-xdrive wheel shares ONE placement line (no per-drivetrain branch)',
      (robotsCode.match(/wheel\.position\.set\(x, sy \* wheelY, part\.r\);/g) ?? []).length === 1,
    );
    check(
      'endplate-cover/source: endWheelSpanY’s swerve centre AND half are the pod’s own inset',
      robotsCode.includes('pod.position.set((Math.sign(x) || 1) * (hl - BB_POD_INSET), sy * (hw - BB_POD_INSET), 0);') &&
        robotsCode.includes('return { center: s * (hw - BB_POD_INSET), half: BB_POD_INSET };'),
    );
  }

  for (const mount of ['front', 'frontback'] as const) {
    // TANK, real wheels
    {
      const spec: RobotSpec = { ...BB_DEFAULT_SPEC, intakeMount: mount, drivetrain: 'tank' };
      const hl = spec.length / 2;
      const wheels = buildWheels(spec);
      for (const w of wheels.nodes) w.updateMatrixWorld(true);
      const plates = buildEndPlates(spec, ID).filter((p) => p.name.startsWith(`robot:${ID}:endplate:front`));
      for (const p of plates) p.updateMatrixWorld(true);

      const frontWheels = wheels.nodes.filter((n) => n.position.x > hl * 0.3);
      check(`endplate-cover/${mount}/tank: the front axle actually has wheels to hide (else this check is vacuous)`, frontWheels.length > 0, String(frontWheels.length));

      for (const w of frontWheels) {
        const wBox = new THREE.Box3().setFromObject(w);
        const side = w.position.y >= 0 ? 'l' : 'r';
        const plate = plates.find((p) => p.name.endsWith(`:${side}`));
        check(`endplate-cover/${mount}/tank: a "${side}" corner plate exists for this wheel`, !!plate);
        if (!plate) continue;
        const pBox = new THREE.Box3().setFromObject(plate);
        const lo = Math.min(wBox.min.y, wBox.max.y);
        const hi = Math.max(wBox.min.y, wBox.max.y);
        check(
          `endplate-cover/${mount}/tank: the "${side}" plate's y-span covers the wheel's own lateral extent`,
          pBox.min.y <= lo + 1e-6 && pBox.max.y >= hi - 1e-6,
          `plate y[${pBox.min.y.toFixed(3)},${pBox.max.y.toFixed(3)}] wheel y[${lo.toFixed(3)},${hi.toFixed(3)}]`,
        );
      }
    }

    // SWERVE, a real pod positioned at the same spot `buildWheels` puts one
    {
      const spec: RobotSpec = { ...BB_DEFAULT_SPEC, intakeMount: mount, drivetrain: 'swerve' };
      const plates = buildEndPlates(spec, ID).filter((p) => p.name.startsWith(`robot:${ID}:endplate:front`));
      for (const p of plates) p.updateMatrixWorld(true);

      for (const s of [1, -1] as const) {
        const side = s === 1 ? 'l' : 'r';
        const { center } = endWheelSpanY(spec, s);
        const pod = buildSwervePod();
        pod.position.set(0, center, 0);
        pod.updateMatrixWorld(true);
        const podBox = new THREE.Box3().setFromObject(pod);

        const plate = plates.find((p) => p.name.endsWith(`:${side}`));
        check(`endplate-cover/${mount}/swerve: a "${side}" corner plate exists for this pod`, !!plate);
        if (!plate) continue;
        const pBox = new THREE.Box3().setFromObject(plate);
        check(
          `endplate-cover/${mount}/swerve: the "${side}" plate's y-span covers the ACTUAL built pod's bbox`,
          pBox.min.y <= podBox.min.y + 1e-6 && pBox.max.y >= podBox.max.y - 1e-6,
          `plate y[${pBox.min.y.toFixed(3)},${pBox.max.y.toFixed(3)}] pod y[${podBox.min.y.toFixed(3)},${podBox.max.y.toFixed(3)}]`,
        );
      }
    }
  }

  // ---- A CORNER PLATE HIDES THE WHOLE WHEEL: floor to plate height, on every build. The first
  // cut raised it above `BB3_MOUTH_SLOT_Z` where the pod sits inside the mouth's throat band (the
  // default Sniper: frontback/swerve) and left a 1-in sliver with the wheels in view. The plate
  // stands on the FRAME face — the pocket's back wall, solid collider at every height already —
  // so it closes nothing an element can use.
  {
    const spec: RobotSpec = { ...BB_DEFAULT_SPEC, intakeMount: 'frontback', drivetrain: 'swerve' };
    const plates = buildEndPlates(spec, ID);
    for (const p of plates) p.updateMatrixWorld(true);
    check('endplate-height: the default Sniper build has its four corner plates (else the check below is vacuous)', plates.length === 4, String(plates.length));
    for (const p of plates) {
      const box = new THREE.Box3().setFromObject(p);
      check(`endplate-height: ${p.name} runs from the floor up (hides the wheel, not just the top of it)`, box.min.z <= 1e-6, `plate z bottom ${box.min.z.toFixed(3)}`);
    }
  }
}

/**
 * THE HOOD IS INSIDE THE PLATES, AND A SIDE PLATE IS ONE PIECE (owner, 2026-09-21).
 *
 * Two sentences: "the shooter's hood meshes with the shooter's parallel plates. It should be
 * inside, with a very slight gap", and "the shooter's parallel plate should not be split in a half
 * (there shouldn't be a hole for the hood)".
 *
 * ⚠️ **NEITHER WAS EVER TRUE OF THE GEOMETRY, AND THAT IS EXACTLY WHY THEY GO IN A CHECK.**
 * Measured on the built group before the change: the arc sat 0.150 clear of each plate's inner
 * face and the arms 0.060, a triangle-AABB sweep of every moving mesh against every fixed one over
 * 41 elevations found only the arms' own pivot boss on the SHAFT it is journalled on, and the side
 * plate was already one extrusion of one outline — 1 component, 0 boundary loops, χ=2. What was
 * wrong was that 0.060 is invisible: an arm that close to a plate READS as part of it, and the
 * arm's lightening bore then reads as a hole in the plate. So the clearance is one named constant
 * now (`BB_HOOD_SIDE_CLEAR`, 0.08), it is the same on both sides at every elevation, and the
 * plate's topology is pinned rather than left to nobody cutting a slot in it later.
 *
 * The interpenetration test is triangle-AABB, which is CONSERVATIVE: an axis-aligned box contains
 * its triangle, so zero box overlaps is a proof of zero interpenetration (the converse does not
 * hold, which is why the two documented contacts are exempted by NAME and not by a tolerance).
 */
function hoodPlateChecks(check: Check): void {
  const DEG = Math.PI / 180;
  // the four the owner's report names, in the order the release table in `config.ts` lists them
  const PITCHES: readonly [string, number][] = [
    ['min', BB_TURRET_PITCH_MIN],
    // the pose a built robot SHOWS before anything aims it (`BB_TURRET_PITCH_REST`) — was the level pose
    ['default', BB_TURRET_PITCH_REST],
    ['57.6°', 57.6 * DEG],
    ['80° cap', BB_TURRET_PITCH_MAX],
  ];
  // every launcher this builder can make a HOOD for: the single turret's head, and the double's
  // two. The MOUNT is a rigid translation of the whole group (`group.position`), so it cannot
  // change a hood-to-plate relationship — it is swept anyway, cheaply, so that stays a measurement.
  const HEADS: readonly [string, 0 | 1, BbMountPos][] = [
    ['single turret', 0, 'center'],
    ['double turret head 0', 0, 'left'],
    ['double turret head 1', 1, 'right'],
  ];

  for (const [label, which, mount] of HEADS) {
    const H = bbHead(which);
    const turret = buildTurret({ ...BB_DEFAULT_SPEC }, mount, which);
    const root3 = new THREE.Group();
    root3.add(turret);
    const axleNode = turret.userData.axle as THREE.Group;
    const pitchNode = turret.userData.pitch as THREE.Group;
    const exitNode = pitchNode.getObjectByName('bb-turret-exit') as THREE.Object3D;
    const axleInv = new THREE.Matrix4();
    const pose = (p: number): void => {
      pitchNode.rotation.y = -p;
      root3.updateMatrixWorld(true);
      axleInv.copy(axleNode.matrixWorld).invert();
    };
    const meshes: THREE.Mesh[] = [];
    turret.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const moving = new Set<THREE.Mesh>();
    pitchNode.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) moving.add(o as THREE.Mesh);
    });
    /** every triangle of `m` as an AABB, in the AXLE frame. */
    const triBoxes = (m: THREE.Mesh): THREE.Box3[] => {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const idx = m.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      const out: THREE.Box3[] = [];
      for (let i = 0; i < n; i += 3) {
        const pts = [0, 1, 2].map((k) =>
          new THREE.Vector3()
            .fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k)
            .applyMatrix4(m.matrixWorld)
            .applyMatrix4(axleInv),
        );
        out.push(new THREE.Box3().setFromPoints(pts));
      }
      return out;
    };
    const lateral = (ms: THREE.Mesh[]): { lo: number; hi: number } => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of ms) {
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const y = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(axleInv).y;
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      return { lo, hi };
    };

    const inner = H.plateGap / 2; // a side plate's INNER face, both sides
    const want = inner - BB_HOOD_SIDE_CLEAR; // …and where the hood's widest part must stop
    const hoodMeshes = meshes.filter((m) => moving.has(m));
    for (const [tag, p] of PITCHES) {
      pose(p);
      const { lo, hi } = lateral(hoodMeshes);
      check(
        `hood-inside/${label} @${tag}: the whole hood stops BB_HOOD_SIDE_CLEAR short of both plate faces`,
        Math.abs(hi - want) < 1e-6 && Math.abs(lo + want) < 1e-6,
        `hood y [${lo.toFixed(6)}, ${hi.toFixed(6)}] vs ±${want.toFixed(6)}; plate faces ±${inner.toFixed(3)}, clear ${BB_HOOD_SIDE_CLEAR}`,
      );
      check(
        `hood-inside/${label} @${tag}: ...strictly inside them, with the gap the owner asked for on EACH side`,
        inner - hi >= BB_HOOD_SIDE_CLEAR - 1e-6 && inner + lo >= BB_HOOD_SIDE_CLEAR - 1e-6 && BB_HOOD_SIDE_CLEAR >= 0.06 && BB_HOOD_SIDE_CLEAR <= 0.1,
        `left ${(inner + lo).toFixed(6)}, right ${(inner - hi).toFixed(6)} (it shipped at 0.060, which reads as touching)`,
      );
      // AND THE RELEASE DID NOT MOVE. Narrowing the hood may not touch `bbMuzzleLocal`: the sim
      // fires from it, so a picture change that moved it would be the sixth round of the same bug.
      const w = new THREE.Vector3();
      exitNode.getWorldPosition(w);
      const mz = bbMuzzleLocal(p, which);
      const local = turretLocal(BB_DEFAULT_SPEC, mount);
      check(
        `hood-inside/${label} @${tag}: ...and the drawn lip is still exactly bbMuzzleLocal(pitch)`,
        Math.hypot(w.x - local.x + mz.back, w.y - local.y, w.z - mz.z) < 1e-9,
        `drawn (${(w.x - local.x).toFixed(6)}, ${w.z.toFixed(6)}) vs sim (${(-mz.back).toFixed(6)}, ${mz.z.toFixed(6)})`,
      );
    }

    // ── ZERO INTERPENETRATION, MOVING × FIXED, OVER THE WHOLE ENVELOPE ──────────────────────
    // Two exemptions, by NAME, and each is a pair a BOX test cannot adjudicate rather than one
    // nobody looked at:
    //  · the SHAFT — the arms' pivot boss is journalled on it, and a boss and its shaft share an
    //    axis by definition;
    //  · the TURRET PLATE — the NECTAR hood's tail dips 0.14 in BELOW it at full elevation, which
    //    is legal because it goes through the FEED SLOT. The slot is a hole, so the plate's
    //    triangles around it have boxes that reach into open air, and a box test reads that as
    //    contact (measured: 81 pairs, POLLEN 0). The vertex statement below is what replaces it,
    //    and it is stricter than a box: every moving vertex is above the plate or inside the slot.
    {
      let hits = 0;
      let worst = '';
      let throughPlate = 0;
      let where = '';
      const N = 41;
      const plateTop = BB_TURRET_PLATE_TOP_Z - BB_TURRET_AXLE_Z; // the plate's top face, axle frame
      for (let i = 0; i < N; i++) {
        const p = BB_TURRET_PITCH_MIN + ((BB_TURRET_PITCH_MAX - BB_TURRET_PITCH_MIN) * i) / (N - 1);
        pose(p);
        const mv = hoodMeshes.map((m) => ({ m, t: triBoxes(m) }));
        for (const f of meshes) {
          if (moving.has(f) || f.name === 'bb-turret-shaft' || f.name === 'bb-turret-plate') continue;
          const ft = triBoxes(f);
          for (const { m, t } of mv) {
            for (const a of t) {
              for (const b of ft) {
                if (!a.intersectsBox(b)) continue;
                hits++;
                if (!worst) worst = `${m.name} × ${f.name} @${((p * 180) / Math.PI).toFixed(0)}°`;
              }
            }
          }
        }
        // …and the plate, per VERTEX, in its own frame: below its top face only through the slot
        for (const m of hoodMeshes) {
          const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let k = 0; k < pos.count; k++) {
            const v = new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld).applyMatrix4(axleInv);
            if (v.z >= plateTop - 1e-6) continue;
            const inSlot =
              v.x >= H.slotBackX - H.axleX - 1e-6 && v.x <= H.slotFrontX - H.axleX + 1e-6 && Math.abs(v.y) <= H.slotHalfW + 1e-6;
            if (inSlot) continue;
            throughPlate++;
            if (!where) where = `${m.name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) @${((p * 180) / Math.PI).toFixed(0)}°`;
          }
        }
      }
      check(
        `hood-inside/${label}: nothing on the pitch node touches anything fixed, at any of ${N} elevations`,
        hits === 0,
        hits === 0 ? 'triangle-AABB is conservative, so this is a proof and not a sample' : `${hits} overlapping triangle boxes — first ${worst}`,
      );
      check(
        `hood-inside/${label}: ...and where it passes the turret plate it passes through the FEED SLOT, nowhere else`,
        throughPlate === 0,
        where || `slot x [${H.slotBackX.toFixed(2)}, ${H.slotFrontX.toFixed(2)}] ±${H.slotHalfW.toFixed(2)} (the NECTAR tail is the only part that ever goes below)`,
      );
    }

    // ── A SIDE PLATE IS ONE CONTINUOUS SOLID ────────────────────────────────────────────────
    // An extrusion of ONE outline with no holes is a closed genus-0 surface: one component, no
    // boundary edge anywhere, χ = V − E + F = 2. A slot or a hood-shaped hole would make it
    // genus 1 (χ = 0) and a split would make it two components; either shows here, and neither can
    // be argued away. The bosses this plate is allowed are BLIND — it carries the shaft through a
    // bearing, not through a cut — so the count it is held to is zero boundary loops.
    for (const plate of meshes.filter((m) => m.name === 'bb-turret-side-plate')) {
      const pos = plate.geometry.getAttribute('position') as THREE.BufferAttribute;
      const idx = plate.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      const ids = new Map<string, number>();
      const vid = (j: number): number => {
        const v = new THREE.Vector3().fromBufferAttribute(pos, j);
        const k = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
        let id = ids.get(k);
        if (id === undefined) {
          id = ids.size;
          ids.set(k, id);
        }
        return id;
      };
      const faces: [number, number, number][] = [];
      for (let i = 0; i < n; i += 3) {
        const a = vid(idx ? idx.getX(i) : i);
        const b = vid(idx ? idx.getX(i + 1) : i + 1);
        const c = vid(idx ? idx.getX(i + 2) : i + 2);
        if (a !== b && b !== c && a !== c) faces.push([a, b, c]); // welding makes some degenerate
      }
      const edges = new Map<string, number>();
      const ek = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        let r = x;
        while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
        return r;
      };
      for (let i = 0; i < ids.size; i++) parent.set(i, i);
      for (const [a, b, c] of faces) {
        for (const [q, s] of [[a, b], [b, c], [c, a]] as const) edges.set(ek(q, s), (edges.get(ek(q, s)) ?? 0) + 1);
        const ra = find(a);
        const rb = find(b);
        const rc = find(c);
        if (ra !== rb) parent.set(ra, rb);
        if (find(b) !== rc) parent.set(find(b), rc);
      }
      const comps = new Set([...parent.keys()].map(find)).size;
      const boundary = [...edges.values()].filter((c) => c === 1).length;
      const chi = ids.size - edges.size + faces.length;
      check(
        `hood-inside/${label}: the side plate is ONE piece with no slot and no hole for the hood`,
        comps === 1 && boundary === 0 && chi === 2,
        `${comps} component(s), ${boundary} boundary edge(s), χ=${chi} → genus ${(2 - chi) / 2} (a slot reads χ=0, a split reads 2 components)`,
      );
    }

    // ── …AND IT IS THE *ONLY* PLATE ON ITS SIDE, FROM THE MOTOR MOUNT TO THE MUZZLE ─────────
    //
    // ⚠️ **OWNER, 2026-09-21, SECOND CORRECTION ON THIS MECHANISM: "The parallel plates of the
    // shooter has a split. The plate in the back that mounts the motor and the plate that retains
    // the flywheel should be the same plate."** The χ test above only ever saw ONE mesh at a time,
    // so it said "one piece" about a part that was one of TWO per side: the plate stopped at the
    // hood's radius (−3.917 in the axle frame, POLLEN) and a 1.47 × 0.22-in EAR carried the motor
    // from 0.63 in further back, in the plate's own plane, with the feed wall's perpendicular face
    // in the gap. A per-mesh check cannot see that. These are about the SET of meshes.
    {
      pose(BB_TURRET_PITCH_MIN);
      const plates = meshes.filter((m) => m.name === 'bb-turret-side-plate');
      const axleV = (m: THREE.Mesh): THREE.Vector3[] => {
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
        const out: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++)
          out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(axleInv));
        return out;
      };
      const boxes = plates.map((m) => new THREE.Box3().setFromPoints(axleV(m)));
      // each plate is PLANAR — its whole length lies in one |y| band, one plate thickness wide —
      // and the two are mirror images, which is what makes them one part and its reflection
      const bands = boxes.map((b) => [Math.min(Math.abs(b.min.y), Math.abs(b.max.y)), Math.max(Math.abs(b.min.y), Math.abs(b.max.y))]);
      check(
        `hood-inside/${label}: exactly TWO side plates, one per side, mirror images at one |y| each`,
        plates.length === 2 &&
          boxes.every((b, i) => Math.abs(bands[i][1] - bands[i][0] - BB_SHOOTER_PLATE_T) < 1e-6 && b.min.y * b.max.y > 0) &&
          boxes[0].min.y * boxes[1].min.y < 0 &&
          Math.abs(bands[0][0] - bands[1][0]) < 1e-6 &&
          Math.abs(bands[0][1] - bands[1][1]) < 1e-6 &&
          Math.abs(boxes[0].min.x - boxes[1].min.x) < 1e-6 &&
          Math.abs(boxes[0].max.x - boxes[1].max.x) < 1e-6 &&
          Math.abs(boxes[0].min.z - boxes[1].min.z) < 1e-6 &&
          Math.abs(boxes[0].max.z - boxes[1].max.z) < 1e-6,
        `${plates.length} plate(s); y ${boxes.map((b) => `[${b.min.y.toFixed(3)}, ${b.max.y.toFixed(3)}]`).join(' ')} (one thickness ${BB_SHOOTER_PLATE_T} each), x [${boxes[0].min.x.toFixed(3)}, ${boxes[0].max.x.toFixed(3)}], z [${boxes[0].min.z.toFixed(3)}, ${boxes[0].max.z.toFixed(3)}]`,
      );
      // ONE PLATE SPANS THE WHOLE MACHINE: the motor's mounting station at the back, the flywheel
      // axle it journals in the middle, and the front standoffs at the nose. Measured off the
      // drawn mesh's own x-extent, not off the constants it was built from.
      const braceFront = Math.max(...BB_TURRET_BRACES.map((s) => Math.cos(s.th) * s.r + BB_TURRET_BRACE_R));
      const motorAxis = -H.motorR;
      check(
        `hood-inside/${label}: ...and each one reaches from the motor's mount past the axle to the exit standoffs`,
        boxes.every((b) => b.min.x <= motorAxis - BB_TURRET_MOTOR_R - 1e-6 && b.max.x >= braceFront - 1e-6 && b.min.x < 0 && b.max.x > 0),
        `plate x [${boxes[0].min.x.toFixed(3)}, ${boxes[0].max.x.toFixed(3)}] vs motor axis ${motorAxis.toFixed(3)} (can rear ${(motorAxis - BB_TURRET_MOTOR_R).toFixed(3)}), axle 0.000, front standoff ${braceFront.toFixed(3)}`,
      );
      // NOTHING ELSE MAY LIE IN A SIDE PLATE'S OWN PLANE. That is exactly what the ears were, and
      // it is the difference between a cross member and a second plate: a member SPANS the
      // channel (its y interval crosses the centreline); anything that does not must keep clear of
      // both plate bands. Two parts are in that class and both clear it — the hood's CHEEK
      // inboard by `BB_HOOD_SIDE_CLEAR`, and the belt outboard by 0.21 in (`BB_BELT_CLEAR` less
      // half the pulley's own width) — where an ear read 0.000 on both sides of the band.
      {
        const band = [H.plateGap / 2, H.plateGap / 2 + BB_SHOOTER_PLATE_T] as const;
        let intruder = '';
        let nearest = Infinity;
        for (const m of meshes) {
          if (m.name === 'bb-turret-side-plate') continue;
          const ys = axleV(m).map((v) => v.y);
          const lo = Math.min(...ys);
          const hi = Math.max(...ys);
          if (lo < 0 && hi > 0) continue; // a cross member: it spans the channel
          const a = Math.min(Math.abs(lo), Math.abs(hi));
          const b = Math.max(Math.abs(lo), Math.abs(hi));
          if (b > band[0] && a < band[1]) intruder = `${m.name} at |y| [${a.toFixed(3)}, ${b.toFixed(3)}] inside the plate's own [${band[0].toFixed(3)}, ${band[1].toFixed(3)}]`;
          else nearest = Math.min(nearest, a >= band[1] ? a - band[1] : band[0] - b);
        }
        check(
          `hood-inside/${label}: ...and NOTHING else lies in a plate's plane — no second "rear plate", only members that cross the channel`,
          intruder === '',
          intruder || `nearest part that does not span the channel clears the plate band by ${nearest.toFixed(3)} in (the ears read 0.000 — they were the plate's own plane)`,
        );
      }
    }

    // ── AND THE FLYWHEEL IS BLACK, WHATEVER THE SPEC SAYS ───────────────────────────────────
    // Three accents, because one accent that happens to be near-black would pass by accident.
    for (const accent of ['magenta', 'red', 'white'] as const) {
      const t = buildTurret({ ...BB_DEFAULT_SPEC, accent }, mount, which);
      let hex: string | undefined;
      t.traverse((o) => {
        if (o.name === 'bb-turret-flywheel') hex = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString();
      });
      check(`hood-inside/${label}: the flywheel is base black under accent "${accent}"`, hex === '12161c', String(hex));
    }
  }

  // ── A DUMPER HAS NO HOOD AT ALL, WHICH IS WHY ITS RELEASE IS FLAT ─────────────────────────
  // `buildDumper` is not exported and `buildRobotGroup` needs a DOM canvas for the sign, so this
  // is the one thing here read off the SOURCE rather than the mesh: the dumper branch builds
  // `bb-dump-arm` and names no turret part. `bbMuzzleZ`'s own leak guard (ROBOT lane) is the other
  // half — a dumper's release stays `BB_LAUNCH_Z0` at every pitch.
  {
    const src = readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderRobots.ts'), 'utf8');
    const from = src.indexOf('function buildDumper(');
    const to = src.indexOf('\nexport function buildRobotGroup(', from);
    const body = src.slice(from, to > from ? to : undefined);
    check(
      'a DUMPER builds no hood and no shooter side plates — nothing for a hood to mesh with',
      from > 0 && to > from && !/bb-turret-|hood/i.test(body) && body.includes("arm.name = 'bb-dump-arm'"),
      `${body.length} chars of buildDumper scanned`,
    );
  }
}

/**
 * FREE CAM (owner, 2026-09-21) — `graphics/freeCam.ts`'s pure state math, checked with no GPU
 * and no scene: the clamps, the reset framing, and the closed-form pose every frame derives from
 * a `FreeCamState`. The SMOOTHING is not here — it lives in `scene/renderCameras.ts` (a
 * `render*`-named file), because it needs `Math.pow`, which this lane's `graphics/` cannot use
 * (see `freeCam.ts`'s own header). `graphicsChecks` above already asserts the whole `graphics/`
 * directory imports neither `three` nor `scene/`; this function pins that rule against this one
 * file too, by name, since the owner spec calls it out specifically.
 */
function freeCamChecks(check: Check): void {
  // ---- clamps hold under extreme input ------------------------------------------------------
  {
    const base: FreeCamState = { yaw: 0, pitch: 0, dist: 100, target: [0, 0] };

    const orbited = orbitFreeCam(base, 1e9, 1e9);
    check(
      'freeCam/clamp: an extreme orbit still clamps pitch into its own envelope',
      orbited.pitch >= FREE_CAM_PITCH_MIN - 1e-9 && orbited.pitch <= FREE_CAM_PITCH_MAX + 1e-9,
      String(orbited.pitch),
    );
    check('freeCam/clamp: an extreme orbit leaves yaw finite (unbounded, but never NaN/Infinity)', Number.isFinite(orbited.yaw), String(orbited.yaw));
    const orbitedNeg = orbitFreeCam(base, -1e9, -1e9);
    check(
      'freeCam/clamp: an extreme NEGATIVE orbit still clamps pitch',
      orbitedNeg.pitch >= FREE_CAM_PITCH_MIN - 1e-9 && orbitedNeg.pitch <= FREE_CAM_PITCH_MAX + 1e-9,
      String(orbitedNeg.pitch),
    );

    // `dollyFreeCam` takes an already-computed multiplicative FACTOR (the caller,
    // `renderCameras.ts`, is what turns a wheel `deltaY` into one — see that file's own note on
    // why the exponential lives there and not here), so an "extreme dolly" is an extreme factor.
    const dolliedIn = dollyFreeCam(base, 1e-9);
    check('freeCam/clamp: an extreme dolly IN never reaches, let alone crosses, the target', dolliedIn.dist >= FREE_CAM_DIST_MIN - 1e-9, String(dolliedIn.dist));
    const dolliedOut = dollyFreeCam(base, 1e9);
    check('freeCam/clamp: an extreme dolly OUT stays at or under the ceiling', dolliedOut.dist <= FREE_CAM_DIST_MAX + 1e-9, String(dolliedOut.dist));
    // and the sentinel path (an overflowed/underflowed factor, which a genuinely pathological
    // `deltaY` could produce) clamps the same way rather than propagating a non-finite distance.
    const dolliedInf = dollyFreeCam(base, Infinity);
    check('freeCam/clamp: a dolly factor of +Infinity clamps to the ceiling, not NaN', dolliedInf.dist === FREE_CAM_DIST_MAX, String(dolliedInf.dist));
    const dolliedZero = dollyFreeCam(base, 0);
    check('freeCam/clamp: a dolly factor of 0 clamps to the floor, not 0', dolliedZero.dist === FREE_CAM_DIST_MIN, String(dolliedZero.dist));

    const panned = panFreeCam(base, 1e9, 1e9);
    check(
      'freeCam/clamp: an extreme pan stays inside the field bounds + margin, x',
      Math.abs(panned.target[0]) <= BB_HALF_X + BB_VIEW_MARGIN + 1e-6,
      String(panned.target[0]),
    );
    check(
      'freeCam/clamp: an extreme pan stays inside the field bounds + margin, y',
      Math.abs(panned.target[1]) <= BB_HALF_Y + BB_VIEW_MARGIN + 1e-6,
      String(panned.target[1]),
    );
    const pannedNeg = panFreeCam(base, -1e9, -1e9);
    check(
      'freeCam/clamp: an extreme pan the OTHER way also stays inside bounds',
      Math.abs(pannedNeg.target[0]) <= BB_HALF_X + BB_VIEW_MARGIN + 1e-6 && Math.abs(pannedNeg.target[1]) <= BB_HALF_Y + BB_VIEW_MARGIN + 1e-6,
    );

    // a real UI event can never hand this module a NaN or an Infinity (a `deltaY`/`clientX`
    // delta is always a real number), but the clamp is the first thing a fuzzer would reach for,
    // and a clamp that lets one non-finite field slip through the whole state is not a clamp.
    const garbage = clampFreeCam({ yaw: NaN, pitch: NaN, dist: NaN, target: [NaN, Infinity] });
    check(
      'freeCam/clamp: NaN/Infinity input clamps to finite, in-range values throughout',
      [garbage.yaw, garbage.pitch, garbage.dist, ...garbage.target].every((v) => Number.isFinite(v)),
      JSON.stringify(garbage),
    );
  }

  // ---- reset equals the default, for BOTH alliances, and is deterministic ------------------
  {
    for (const alliance of ['red', 'blue'] as const) {
      const viewAngle = viewAngleOf(alliance);
      const a = defaultFreeCam(viewAngle);
      const b = defaultFreeCam(viewAngle);
      check(
        `freeCam/reset: ${alliance}'s default framing is deterministic (same viewAngle in, same state out)`,
        a.yaw === b.yaw && a.pitch === b.pitch && a.dist === b.dist && a.target[0] === b.target[0] && a.target[1] === b.target[1],
      );
      check(`freeCam/reset: ${alliance}'s default is already inside every clamp`, JSON.stringify(a) === JSON.stringify(clampFreeCam(a)));
      check(`freeCam/reset: ${alliance}'s default looks at the field centre`, a.target[0] === 0 && a.target[1] === 0);
    }
    const red = defaultFreeCam(viewAngleOf('red'));
    const blue = defaultFreeCam(viewAngleOf('blue'));
    check("freeCam/reset: red and blue reset to DIFFERENT framings (each faces its own wall)", red.yaw !== blue.yaw, `${red.yaw} vs ${blue.yaw}`);
    // `yaw` is the azimuth FROM the target TO the eye, so two alliances standing on opposite
    // walls put the two eyes on exactly opposite sides of the field — π apart.
    const wrapped = Math.atan2(Math.sin(red.yaw - blue.yaw), Math.cos(red.yaw - blue.yaw));
    check('freeCam/reset: red and blue reset to OPPOSITE azimuths (π apart)', Math.abs(Math.abs(wrapped) - Math.PI) < 1e-9, String(wrapped));
  }

  // ---- the pose looks AT the target from the stated distance/angles, tolerance 1e-6 --------
  {
    const cases: FreeCamState[] = [
      { yaw: 0, pitch: FREE_CAM_PITCH_MIN, dist: FREE_CAM_DIST_MIN, target: [0, 0] },
      { yaw: Math.PI / 3, pitch: (45 * Math.PI) / 180, dist: 200, target: [30, -40] },
      { yaw: -2.7, pitch: FREE_CAM_PITCH_MAX, dist: FREE_CAM_DIST_MAX, target: [-BB_HALF_X, BB_HALF_Y] },
      defaultFreeCam(viewAngleOf('red')),
      defaultFreeCam(viewAngleOf('blue')),
    ];
    for (const s of cases) {
      const pose = freeCamPose(s);
      const [ex, ey, ez] = pose.eye;
      const [tx, ty, tz] = pose.target;
      check("freeCam/pose: the target is the state's own target, on the floor", tx === s.target[0] && ty === s.target[1] && tz === 0);
      const dx = ex - tx;
      const dy = ey - ty;
      const dz = ez - tz;
      const dist = Math.hypot(dx, dy, dz);
      check('freeCam/pose: the eye sits exactly `dist` from the target', Math.abs(dist - s.dist) < 1e-6, `${dist} vs ${s.dist}`);
      const pitch = Math.atan2(dz, Math.hypot(dx, dy));
      check("freeCam/pose: the eye's elevation IS the state's pitch", Math.abs(pitch - s.pitch) < 1e-6, `${pitch} vs ${s.pitch}`);
      const yaw = Math.atan2(dy, dx);
      const yawDiff = Math.abs(Math.atan2(Math.sin(yaw - s.yaw), Math.cos(yaw - s.yaw)));
      check("freeCam/pose: the eye's azimuth IS the state's yaw", yawDiff < 1e-6, `${yaw} vs ${s.yaw}`);
    }
  }

  // ---- mouse layouts (owner, 2026-09-21: middle-drag pans; CAD presets) ----------------------
  {
    // THE GROUND FOLLOWS THE CURSOR. Eye on the -x side looking +x (yaw = PI): screen-right is
    // -y, so a drag RIGHT must move the look-at point to +y, and a drag DOWN must move it +x.
    const grab: FreeCamState = { yaw: Math.PI, pitch: 0.6, dist: 100, target: [0, 0] };
    const right = panFreeCam(grab, 100, 0).target;
    const down = panFreeCam(grab, 0, 100).target;
    check('freeCam/pan: dragging right slides the field right (the look-at point moves screen-left)', right[1] > 1 && Math.abs(right[0]) < 1e-6, String(right));
    check('freeCam/pan: dragging down slides the field toward the viewer (the look-at point moves away)', down[0] > 1 && Math.abs(down[1]) < 1e-6, String(down));
    // THE FULL MAPPING TABLE, one row per preset — every chord that IS a gesture, and the
    // no-modifier/other-modifier cases that must be nothing at all. Written out rather than
    // derived from the same table the code reads, which would assert nothing.
    type Row = [button: number, mods: string, want: FreeCamGesture | null];
    const M = (s: string) => ({ shift: s.includes('S'), ctrl: s.includes('C'), alt: s.includes('A') });
    const TABLE: Record<Exclude<FreeCamPreset, 'custom'>, readonly Row[]> = {
      // DSIM is ONSHAPE plus left-drag orbit and shift+left pan (owner: "DSIM default should
      // also be very close to how the onshape one works").
      dsim: [
        [2, '', 'orbit'],
        [0, '', 'orbit'],
        [1, '', 'pan'],
        [2, 'C', 'pan'],
        [0, 'S', 'pan'],
        [2, 'S', null],
        [1, 'C', null],
        [0, 'C', null],
      ],
      // help.onshape.com, "View Navigation and the View Cube": 3D rotate = "Right-mouse-button
      // click, then drag"; 2D pan = "Ctrl + Right-mouse-button click, then drag / Middle-mouse-
      // button click, then drag". Left is SELECT and stays unbound.
      onshape: [
        [2, '', 'orbit'],
        [1, '', 'pan'],
        [2, 'C', 'pan'],
        [0, '', null],
        [0, 'S', null],
        [1, 'S', null],
        [2, 'S', null],
      ],
      // SOLIDWORKS: middle drag rotates (help.solidworks.com, "Middle Mouse Button Functions");
      // Ctrl+middle pans and Shift+middle zooms (Autodesk's own SolidWorks mouse preset).
      solidworks: [
        [1, '', 'orbit'],
        [1, 'C', 'pan'],
        [1, 'S', 'zoom'],
        [0, '', null],
        [2, '', null],
        [1, 'SC', null],
      ],
      // Fusion preferences reference: "Zoom: Roll the middle mouse button or Ctrl + Shift +
      // middle mouse button. Pan: Middle mouse button. Orbit: Shift + middle mouse button."
      fusion: [
        [1, '', 'pan'],
        [1, 'S', 'orbit'],
        [1, 'SC', 'zoom'],
        [1, 'C', null],
        [0, '', null],
        [2, '', null],
      ],
      // Blender's own default keymap: `view3d.rotate` MIDDLEMOUSE, `view3d.move` shift+MIDDLE,
      // `view3d.zoom` ctrl+MIDDLE.
      blender: [
        [1, '', 'orbit'],
        [1, 'S', 'pan'],
        [1, 'C', 'zoom'],
        [1, 'SC', null],
        [0, '', null],
        [2, '', null],
      ],
    };
    for (const preset of Object.keys(TABLE) as (keyof typeof TABLE)[]) {
      const nav = freeCamNavFor(preset);
      for (const [button, mods, want] of TABLE[preset]) {
        const got = freeCamGesture(nav, button, M(mods));
        check(`freeCam/nav: ${preset} — button ${button}${mods ? ` +${mods}` : ''} is ${want ?? 'nothing'}`, got === want, String(got));
      }
      // ALT IS IGNORED BY A PRESET, so Onshape's own `Alt + right-drag` constrained rotate lands
      // on a plain orbit here rather than on nothing at all.
      for (const [button, mods, want] of TABLE[preset]) {
        check(`freeCam/nav: ${preset} — alt does not change button ${button}${mods ? ` +${mods}` : ''}`, freeCamGesture(nav, button, M(`${mods}A`)) === want);
      }
    }
    // a layout nobody can aim with is the failure that matters: every preset must reach BOTH
    // orbit and pan from some button + modifier, and must ignore the back/forward buttons.
    const combos = ['', 'S', 'C', 'SC'].map(M);
    for (const preset of FREE_CAM_PRESETS) {
      const nav = freeCamNavFor(preset);
      const reach = new Set<string | null>();
      for (const b of [0, 1, 2]) for (const m of combos) reach.add(freeCamGesture(nav, b, m));
      check(`freeCam/nav: ${preset} can both orbit and pan`, reach.has('orbit') && reach.has('pan'), [...reach].join(','));
      check(`freeCam/nav: ${preset} ignores mouse buttons 3 and 4`, freeCamGesture(nav, 3, M('')) === null && freeCamGesture(nav, 4, M('')) === null);
      check(`freeCam/nav: ${preset} has a label and a hint`, FREE_CAM_PRESET_LABEL[preset].length > 0 && FREE_CAM_PRESET_HINT[preset].length > 10);
    }
    // the scene must ASK the table rather than hardcode buttons, and must cancel the middle
    // press's autoscroll or a middle-drag dies after its first pixel on Windows.
    const scene = readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderScene.ts'), 'utf8');
    check('freeCam/nav: renderScene routes the press through freeCamGesture', scene.includes('freeCamGesture(this.freeNav, e.button'));
    check('freeCam/nav: renderScene folds ⌘ into ctrl and passes alt through', scene.includes('e.ctrlKey || e.metaKey, alt: e.altKey'));
    check("freeCam/nav: renderScene cancels a middle press's autoscroll while the free camera is up", scene.includes("addEventListener('mousedown', onMouseDown)") && scene.includes('e.button === 1) e.preventDefault()'));
  }

  // ---- THE DIRECTION SENSES, pinned with explicit geometry ----------------------------------
  //
  // ⚠️ This block is the owner's 2026-09-21 report ("Onshape orbit is right drag but it is
  // reversed"). Yesterday's `freeOrbit` added `+dx·rate` to `yaw`, and d(eye)/d(yaw) is exactly
  // the camera's screen-RIGHT vector — so the EYE followed the cursor and the field went the
  // other way. Every CAD package drags the MODEL. The geometry below is stated in full so that a
  // future change cannot satisfy it by accident.
  {
    const nav = freeCamNavFor('onshape');
    // Eye on the −x side looking +x: yaw = π puts the eye at (−dist, 0), so screen-right is −y
    // and screen-left is +y.
    const s: FreeCamState = { yaw: Math.PI, pitch: 0.5, dist: 150, target: [0, 0] };
    const dragRight = freeCamOrbitDelta(nav, 100, 0, 0.006, 0.004);
    const afterRight = orbitFreeCam(s, dragRight.dYaw, dragRight.dPitch);
    const eyeRight = freeCamPose(afterRight).eye;
    check(
      'freeCam/sense: an orbit drag to the RIGHT swings the FIELD right — the eye goes screen-LEFT (+y here)',
      dragRight.dYaw < 0 && eyeRight[1] > 1,
      `dYaw ${dragRight.dYaw}, eye ${eyeRight}`,
    );
    const dragLeft = freeCamOrbitDelta(nav, -100, 0, 0.006, 0.004);
    const eyeLeft = freeCamPose(orbitFreeCam(s, dragLeft.dYaw, dragLeft.dPitch)).eye;
    check('freeCam/sense: and a drag to the LEFT is the mirror of it (the eye goes to −y)', eyeLeft[1] < -1, String(eyeLeft));
    // DOWN tips the field's top toward the viewer, i.e. the eye RISES. (Grab the front of a ball,
    // pull down, and its top rolls toward you.) This axis was already right and is NOT flipped.
    const dragDown = freeCamOrbitDelta(nav, 0, 100, 0.006, 0.004);
    const downPose = freeCamPose(orbitFreeCam(s, dragDown.dYaw, dragDown.dPitch));
    check(
      'freeCam/sense: an orbit drag DOWN raises the eye (the field tips its top toward the viewer)',
      dragDown.dPitch > 0 && downPose.eye[2] > freeCamPose(s).eye[2],
      `dPitch ${dragDown.dPitch}`,
    );
    const dragUp = freeCamOrbitDelta(nav, 0, -100, 0.006, 0.004);
    check('freeCam/sense: an orbit drag UP lowers the eye', freeCamPose(orbitFreeCam(s, dragUp.dYaw, dragUp.dPitch)).eye[2] < freeCamPose(s).eye[2]);
    // THE SPECTATOR ORBIT CAMERA IS THE HOUSE REFERENCE and has always gone this way: `orbitDrag`
    // does `orbitYaw -= dx · ORBIT_DRAG_YAW`, in the same yaw convention. Free cam disagreeing
    // with it was the bug, so the two are pinned to the same sign here.
    const cams = readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderCameras.ts'), 'utf8');
    check('freeCam/sense: the spectator orbit still subtracts dx from its yaw (the sense free cam now matches)', /orbitYaw\s*-=\s*dx\s*\*\s*ORBIT_DRAG_YAW/.test(cams));
    check('freeCam/sense: free cam takes its orbit delta from the pure module, not from a sign written at the call site', cams.includes('freeCamOrbitDelta(freeNav, dx, dy'));

    // the INVERSIONS are the player putting either axis back, and each one moves only its own.
    const invX = { ...nav, invertOrbitX: true };
    const invY = { ...nav, invertOrbitY: true };
    const base = freeCamOrbitDelta(nav, 100, 100, 0.006, 0.004);
    const x = freeCamOrbitDelta(invX, 100, 100, 0.006, 0.004);
    const y = freeCamOrbitDelta(invY, 100, 100, 0.006, 0.004);
    check('freeCam/sense: invert orbit left/right flips ONLY the yaw', x.dYaw === -base.dYaw && x.dPitch === base.dPitch);
    check('freeCam/sense: invert orbit up/down flips ONLY the pitch', y.dPitch === -base.dPitch && y.dYaw === base.dYaw);
    // and the sensitivity is a plain multiplier on both
    const fast = freeCamOrbitDelta({ ...nav, orbitSpeed: 2 }, 100, 100, 0.006, 0.004);
    check('freeCam/sense: orbit sensitivity scales both axes', Math.abs(fast.dYaw - base.dYaw * 2) < 1e-12 && Math.abs(fast.dPitch - base.dPitch * 2) < 1e-12);
    // PAN: the gain is the sensitivity, negated when inverted, and inverting it really does send
    // the ground the other way.
    check('freeCam/sense: invert pan negates the gain', freeCamPanGain({ ...nav, invertPan: true }) === -1 && freeCamPanGain(nav) === 1);
    const pannedInv = panFreeCam(s, 100, 0, freeCamPanGain({ ...nav, invertPan: true })).target;
    check('freeCam/sense: an inverted pan dragged right moves the look-at point the other way', pannedInv[1] < -1, String(pannedInv));
    const pannedFast = panFreeCam(s, 100, 0, 2).target;
    const pannedSlow = panFreeCam(s, 100, 0, 1).target;
    check('freeCam/sense: pan sensitivity scales the travel', Math.abs(pannedFast[1] - pannedSlow[1] * 2) < 1e-9);
  }

  // ---- the wheel: per-preset default, and the override ---------------------------------------
  {
    // The two packages that PUBLISH a default agree with ours: Onshape's own navigation table
    // says "Scroll wheel up: Zoom in", and Blender's default keymap binds `WHEELINMOUSE` to
    // `view3d.zoom` with `delta 1`. The other two publish the buttons and not the wheel — see
    // `docs/biobuzz/free-cam-presets.md`.
    for (const preset of FREE_CAM_PRESETS) {
      const nav = freeCamNavFor(preset);
      check(`freeCam/wheel: ${preset} defaults to its own published direction`, freeCamWheelDir(nav) === FREE_CAM_PRESET_WHEEL[preset], freeCamWheelDir(nav));
      check(`freeCam/wheel: ${preset} — "preset default" is not a third behaviour`, nav.wheel === 'preset' && (freeCamWheelDir(nav) === 'in' || freeCamWheelDir(nav) === 'out'));
    }
    const onshape = freeCamNavFor('onshape');
    check('freeCam/wheel: onshape — forward zooms IN, as its table says', freeCamWheelDir(onshape) === 'in' && freeCamWheelSign(onshape) === 1);
    check('freeCam/wheel: the override beats the preset in both directions', freeCamWheelSign({ ...onshape, wheel: 'out' }) === -1 && freeCamWheelSign({ ...onshape, wheel: 'in' }) === 1);
    // END TO END, with `renderCameras.ts`'s own formula spelled out here: a FORWARD push is a
    // NEGATIVE `deltaY`, and on the default it must shorten the distance.
    const s: FreeCamState = { yaw: 1, pitch: 0.5, dist: 200, target: [0, 0] };
    const forward = (nav: typeof onshape): number => dollyFreeCam(s, Math.exp(-100 * freeCamWheelSign(nav) * 1 * 0.0012)).dist;
    check('freeCam/wheel: a forward push zooms IN on the default', forward(onshape) < s.dist, String(forward(onshape)));
    check('freeCam/wheel: a forward push zooms OUT once the player inverts it', forward({ ...onshape, wheel: 'out' }) > s.dist);
    const slow = dollyFreeCam(s, Math.exp(-100 * 1 * 0.5 * 0.0012)).dist;
    const fastD = dollyFreeCam(s, Math.exp(-100 * 1 * 2 * 0.0012)).dist;
    check('freeCam/wheel: zoom sensitivity moves the same notch further', fastD < slow && slow < s.dist, `${fastD} < ${slow} < ${s.dist}`);
    const cams = readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderCameras.ts'), 'utf8');
    check('freeCam/wheel: the camera applies the sign and the sensitivity, not the listener', cams.includes('freeCamWheelSign(freeNav) * freeNav.zoomSpeed * FREE_DOLLY_RATE'));
  }

  // ---- zoom to cursor keeps the point under the cursor exactly where it is --------------------
  {
    // The invariant that MAKES it true, checked rather than eyeballed: scaling the camera about
    // the floor point `P` leaves every direction from the eye to `P` unchanged (the eye only
    // slides along the line through `P`) and leaves the view direction unchanged — so `P` keeps
    // its screen position whatever the projection is.
    const s: FreeCamState = { yaw: 2.1, pitch: 0.5, dist: 200, target: [10, -20] };
    const P: [number, number, number] = [35, 12, 0];
    for (const f of [0.8, 1.25]) {
      const n = dollyFreeCamToward(s, f, P[0], P[1]);
      check(`freeCam/cursor: f=${f} — the dolly itself is unchanged (dist × f), and no clamp bit`, Math.abs(n.dist - s.dist * f) < 1e-9, String(n.dist));
      check(`freeCam/cursor: f=${f} — yaw and pitch are untouched`, n.yaw === s.yaw && n.pitch === s.pitch);
      const e0 = freeCamPose(s).eye;
      const e1 = freeCamPose(n).eye;
      const ok = [0, 1, 2].every((i) => Math.abs(e1[i] - P[i] - (e0[i] - P[i]) * f) < 1e-9);
      check(`freeCam/cursor: f=${f} — the eye moves exactly along the line through the cursor point`, ok, `${e0} -> ${e1}`);
      const t1 = freeCamPose(n).target;
      const tOk = [0, 1, 2].every((i) => Math.abs(t1[i] - P[i] - (freeCamPose(s).target[i] - P[i]) * f) < 1e-9);
      check(`freeCam/cursor: f=${f} — and so does the look-at point, so the view direction is identical`, tOk, String(t1));
    }
    // zooming toward the point you are ALREADY looking at is the ordinary dolly, to the bit.
    const same = dollyFreeCamToward(s, 0.8, s.target[0], s.target[1]);
    check('freeCam/cursor: with the cursor on the look-at point it IS the plain dolly', JSON.stringify(same) === JSON.stringify(dollyFreeCam(s, 0.8)));
    // a non-finite cursor point (an unprojection that degenerated) falls back rather than
    // poisoning the target
    check('freeCam/cursor: a non-finite cursor point falls back to the plain dolly', JSON.stringify(dollyFreeCamToward(s, 0.8, NaN, 0)) === JSON.stringify(dollyFreeCam(s, 0.8)));
    check('freeCam/cursor: it is OFF by default — only Blender documents the behaviour, as one you enable', FREE_CAM_NAV_DEFAULT.zoomToCursor === false);
    const scene = readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderScene.ts'), 'utf8');
    check('freeCam/cursor: the wheel listener hands the camera the cursor in clip space', scene.includes('this.cameras.freeDolly(e.deltaY, this.ndcOf(e))'));
    const cams = readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderCameras.ts'), 'utf8');
    check('freeCam/cursor: the camera only consults it when the device asked for it', cams.includes('freeNav.zoomToCursor && ndc ? floorUnder('));
  }

  // ---- the CUSTOM layout: capture, steal, and what an unbound gesture does --------------------
  {
    const b = (button: 0 | 1 | 2, shift = false, ctrl = false, alt = false): FreeCamBind => ({ button, shift, ctrl, alt });
    const nav = freeCamNavFor('custom');
    check('freeCam/custom: an untouched custom layout is already usable (orbit, pan and zoom all bound)', !!nav.custom.orbit && !!nav.custom.pan && !!nav.custom.zoom);
    check('freeCam/custom: and it is Onshape-shaped — right orbits, middle pans', freeCamGesture(nav, 2, { shift: false, ctrl: false, alt: false }) === 'orbit' && freeCamGesture(nav, 1, { shift: false, ctrl: false, alt: false }) === 'pan');
    // STEALING, the key binder's own policy: the chord moves, the loser goes UNBOUND.
    const stolen = bindFreeCamCustom(nav.custom, 'pan', b(2));
    check('freeCam/custom: binding pan to a chord orbit held STEALS it', stolen.pan?.button === 2 && stolen.orbit === null);
    const navStolen = { ...nav, custom: stolen };
    check('freeCam/custom: and the stolen-from gesture then answers to nothing', freeCamGesture(navStolen, 2, { shift: false, ctrl: false, alt: false }) === 'pan');
    check('freeCam/custom: an unbound gesture is simply unreachable, never a fallback to a preset', ![0, 1, 2].some((btn) => freeCamGesture(navStolen, btn, { shift: false, ctrl: false, alt: false }) === 'orbit'));
    // a DIFFERENT chord on the same button does not steal — the modifiers are part of it.
    const kept = bindFreeCamCustom(nav.custom, 'zoom', b(2, true));
    check('freeCam/custom: shift+right does not steal plain right', kept.orbit?.button === 2 && kept.zoom?.shift === true);
    // ALT IS EXACT in a custom layout (it is ignored only by the PRESETS), or two of the
    // player's own bindings would be indistinguishable.
    const withAlt = { ...nav, custom: bindFreeCamCustom(nav.custom, 'zoom', b(0, false, false, true)) };
    check('freeCam/custom: alt+left is a gesture, and plain left is not', freeCamGesture(withAlt, 0, { shift: false, ctrl: false, alt: true }) === 'zoom' && freeCamGesture(withAlt, 0, { shift: false, ctrl: false, alt: false }) === null);
    check('freeCam/custom: the keycap label spells the whole chord', freeCamBindLabel(b(1, true, true, true)) === 'Ctrl+Shift+Alt+Middle' && freeCamBindLabel(null) === 'Unbound');
    const ui = readFileSync(join(root, 'src', 'ui', 'GraphicsSection.tsx'), 'utf8');
    check('freeCam/custom: the capture effect depends on `capture` alone, with the nav in a ref', ui.includes('navRef.current') && /\}, \[capture\]\);/.test(ui));
    check('freeCam/custom: Escape cancels a capture rather than binding anything', ui.includes("if (e.key === 'Escape')"));
  }

  // ---- ONE key, coerced field by field, and an older blob still loads -------------------------
  {
    const d = FREE_CAM_NAV_DEFAULT;
    check('freeCam/store: an absent or corrupt blob is the default, whole', JSON.stringify(coerceFreeCamNav(null)) === JSON.stringify(d) && JSON.stringify(coerceFreeCamNav('nope')) === JSON.stringify(d) && JSON.stringify(coerceFreeCamNav({})) === JSON.stringify(d));
    check('freeCam/store: an unknown preset falls back to dsim, which is the one that must exist', coerceFreeCamNav({ preset: 'catia' }).preset === 'dsim');
    // ⚠️ THE FIRST SHIPPED SHAPE was `{ preset, invertZoom }`. A device that stored `invertZoom:
    // true` asked for "forward zooms out" and must still get it.
    const old = coerceFreeCamNav({ preset: 'onshape', invertZoom: true });
    check('freeCam/store: an OLD blob keeps its preset and its inverted wheel', old.preset === 'onshape' && old.wheel === 'out' && freeCamWheelSign(old) === -1);
    const oldPlain = coerceFreeCamNav({ preset: 'blender', invertZoom: false });
    check('freeCam/store: an old blob that never inverted follows its preset', oldPlain.wheel === 'preset' && freeCamWheelDir(oldPlain) === FREE_CAM_PRESET_WHEEL.blender);
    check('freeCam/store: every new field defaults on an old blob', old.smoothing === true && old.zoomToCursor === false && old.orbitSpeed === 1 && old.custom.orbit?.button === 2);
    // per-field degradation, not per-blob
    const mixed = coerceFreeCamNav({ preset: 'fusion', wheel: 'sideways', orbitSpeed: 'fast', panSpeed: 99, zoomSpeed: -3, smoothing: 0, invertPan: 1, custom: { orbit: { button: 7 }, zoom: null } });
    check('freeCam/store: a bad wheel value degrades to the preset default alone', mixed.preset === 'fusion' && mixed.wheel === 'preset');
    check('freeCam/store: a non-numeric speed is 1 and an out-of-range one clamps', mixed.orbitSpeed === 1 && mixed.panSpeed === 4 && mixed.zoomSpeed === 0.25);
    check('freeCam/store: only a literal false turns smoothing off, and only a literal true inverts', mixed.smoothing === true && mixed.invertPan === false);
    check('freeCam/store: an illegal custom button is UNBOUND, and an explicit null stays null', mixed.custom.orbit === null && mixed.custom.zoom === null);
    check('freeCam/store: a custom entry the blob never mentioned keeps its default', mixed.custom.pan?.button === 1);
    check('freeCam/store: a full round trip is byte-identical', JSON.stringify(coerceFreeCamNav(JSON.parse(JSON.stringify(mixed)))) === JSON.stringify(mixed));
    // ONE key, so the whole thing survives or falls over together
    const keys = readFileSync(join(root, 'src', 'storageKeys.ts'), 'utf8');
    check('freeCam/store: it is still ONE storage key', (keys.match(/FREE_CAM_NAV_KEY/g) ?? []).length >= 1);
  }

  // ---- graphics/ still imports neither three nor scene/, pinned for this file by name -------
  {
    const src = readFileSync(join(BIOBUZZ_DIR, 'graphics', 'freeCam.ts'), 'utf8');
    check('freeCam/source: graphics/freeCam.ts does not import three', !/from\s+['"]three['"]/.test(src));
    check('freeCam/source: graphics/freeCam.ts does not import scene/', !/from\s+['"]\.\.\/scene\//.test(src));
  }
}

/**
 * DRIVER EYE (owner, 2026-09-21) — "Your height": the height-accurate BIOBUZZ 3D driver camera.
 * `graphics/driverEye.ts` is pure math (eye point, aim, clamps); this checks that math directly,
 * then wires `scene/renderCameras.ts`'s actual `createCameras()` against it for the two
 * behaviours that live in that file rather than in the pure module — falling all the way back
 * to the legacy fit when the setting is unset, and landing EXACTLY on `driverEyePoint`'s answer
 * when it is set.
 */
function driverEyeChecks(check: Check): void {
  const frameFor = (overrides: Partial<SceneFrame> = {}): SceneFrame => ({
    alpha: 0,
    viewAngle: viewAngleOf('blue'),
    camera: 'driver',
    width: 1600,
    height: 900,
    dpr: 1,
    ...overrides,
  });

  // ---- coerceDriverHeightIn: field-by-field, like every other stored setting -----------------
  {
    check('driverEye/coerce: null is the explicit "unset", passed through', coerceDriverHeightIn(null, 70) === null);
    check('driverEye/coerce: a value in range round-trips (to 0.1 in)', coerceDriverHeightIn(68.25, null) === 68.3);
    check(
      'driverEye/coerce: below the floor clamps UP to it, never falls back',
      coerceDriverHeightIn(DRIVER_HEIGHT_MIN_IN - 20, 70) === DRIVER_HEIGHT_MIN_IN,
    );
    check(
      'driverEye/coerce: above the ceiling clamps DOWN to it, never falls back',
      coerceDriverHeightIn(DRIVER_HEIGHT_MAX_IN + 20, 70) === DRIVER_HEIGHT_MAX_IN,
    );
    check('driverEye/coerce: NaN/junk falls back to what was already stored, not to null', coerceDriverHeightIn(Number.NaN, 70) === 70);
    check('driverEye/coerce: a non-number falls back the same way', coerceDriverHeightIn('5 ft 8 in', 70) === 70);
  }

  // ---- driverEyePoint: red/blue are point mirrors of each other through the field centre -----
  // (TOP mirrors to BOTTOM, not to TOP — see driverEye.ts's own header on why: point-mirroring
  // flips the y sign the role already encodes, and `bbRoleLabel` already resolves TOP/BOTTOM so
  // that the label means the same world-y sign on either alliance's own wall.)
  {
    const h = 70;
    const redTop = driverEyePoint('red', 'TOP', h);
    const blueBottom = driverEyePoint('blue', 'BOTTOM', h);
    const redBottom = driverEyePoint('red', 'BOTTOM', h);
    const blueTop = driverEyePoint('blue', 'TOP', h);
    check(
      "driverEye/mirror: red TOP is blue BOTTOM's point mirror through the field centre",
      Math.abs(redTop.x + blueBottom.x) < 1e-9 && Math.abs(redTop.y + blueBottom.y) < 1e-9 && redTop.z === blueBottom.z,
      `${JSON.stringify(redTop)} vs -${JSON.stringify(blueBottom)}`,
    );
    check(
      "driverEye/mirror: red BOTTOM is blue TOP's point mirror through the field centre",
      Math.abs(redBottom.x + blueTop.x) < 1e-9 && Math.abs(redBottom.y + blueTop.y) < 1e-9 && redBottom.z === blueTop.z,
      `${JSON.stringify(redBottom)} vs -${JSON.stringify(blueTop)}`,
    );
  }

  // ---- TOP vs BOTTOM differ by exactly the stated along-wall offset and NOTHING else ----------
  {
    for (const alliance of ['red', 'blue'] as const) {
      const h = 65;
      const top = driverEyePoint(alliance, 'TOP', h);
      const bottom = driverEyePoint(alliance, 'BOTTOM', h);
      const area = ALLIANCE_AREA[alliance];
      const expectedOffset = 2 * ROLE_ALONG_WALL_FRACTION * (area.y1 - area.y0);
      check(`driverEye/role: ${alliance} TOP and BOTTOM sit at the same x (the same wall)`, top.x === bottom.x, `${top.x} vs ${bottom.x}`);
      check(`driverEye/role: ${alliance} TOP and BOTTOM sit at the same eye height`, top.z === bottom.z);
      check(
        `driverEye/role: ${alliance} TOP/BOTTOM differ along the wall by exactly a quarter each way`,
        Math.abs(top.y - bottom.y - expectedOffset) < 1e-9,
        `${top.y - bottom.y} vs ${expectedOffset}`,
      );
    }
  }

  // ---- eye z tracks the height setting, less the vertex offset --------------------------------
  {
    for (const h of [DRIVER_HEIGHT_MIN_IN, 60, 70.4, DRIVER_HEIGHT_MAX_IN]) {
      const p = driverEyePoint('blue', 'TOP', h);
      check(`driverEye/z: eye height at ${h} in tracks height − ${EYE_VERTEX_OFFSET_IN}`, Math.abs(p.z - (h - EYE_VERTEX_OFFSET_IN)) < 1e-9, String(p.z));
    }
  }

  // ---- the point is inside the alliance area rect and outside the field -----------------------
  {
    for (const alliance of ['red', 'blue'] as const) {
      for (const role of ['TOP', 'BOTTOM'] as const) {
        const p = driverEyePoint(alliance, role, 66);
        const area = ALLIANCE_AREA[alliance];
        const inArea = p.x >= Math.min(area.x0, area.x1) - 1e-9 && p.x <= Math.max(area.x0, area.x1) + 1e-9 && p.y >= area.y0 - 1e-9 && p.y <= area.y1 + 1e-9;
        check(`driverEye/area: ${alliance} ${role} sits inside its own ALLIANCE_AREA rect`, inArea, JSON.stringify(p));
        check(`driverEye/area: ${alliance} ${role} sits outside the field`, Math.abs(p.x) > BB_HALF_X, String(p.x));
      }
      // and it is `STAND_BACK_IN` past the area's own field-side edge, not merely "outside".
      const p = driverEyePoint(alliance, 'TOP', 66);
      const area = ALLIANCE_AREA[alliance];
      const fieldSideX = Math.abs(area.x0) < Math.abs(area.x1) ? area.x0 : area.x1;
      check(`driverEye/area: ${alliance} stands STAND_BACK_IN behind its own wall`, Math.abs(Math.abs(p.x - fieldSideX) - STAND_BACK_IN) < 1e-9, String(p.x - fieldSideX));
    }
  }

  // ---- driverEyeAim: yaw/pitch point at field centre with no robot, and blend toward one ------
  {
    const eye = { x: -90, y: 0, z: 60 };
    const noRobot = driverEyeAim(eye, null);
    check('driverEye/aim: with no robot, yaw points toward field centre (+x from a red-side eye)', Math.abs(noRobot.yaw) < 1e-9, String(noRobot.yaw));
    const withRobot = driverEyeAim(eye, { x: 0, y: 40, z: 0 });
    check('driverEye/aim: a robot off to one side pulls the yaw off zero, toward it', withRobot.yaw > 1e-6, String(withRobot.yaw));
    check('driverEye/aim: yaw stays finite and pitch stays finite for an ordinary eye/robot pair', Number.isFinite(withRobot.yaw) && Number.isFinite(withRobot.pitch));
  }

  // ---- THE HEIGHT-ACCURATE DRIVER VIEW (owner, 2026-09-24, four reports in a row): "the hive should
  //      be fully visible", then "extremely choppy, especially coming off the wall... Robot is off the
  //      frame", then "the whole field should be visible in driver view at all times", then "Not
  //      fixed driver view tho" — so the whole field and both hives are ALWAYS in frame, and the
  //      view turns toward the robot within the room that leaves, continuously.
  {
    const pts = fieldViewPoints(BB_HALF_X, BB_HALF_Y, BB3_WALL_H);
    let cases = 0;
    let lost = 0;
    let turned = 0;
    const lostAt: string[] = [];
    for (const alliance of ['red', 'blue'] as const) {
      for (const role of ['TOP', 'BOTTOM'] as const) {
        for (const h of [DRIVER_HEIGHT_MIN_IN, 68, DRIVER_HEIGHT_MAX_IN]) {
          for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
            for (const hfov of [60, 100, 120]) {
              const cap = (vFovFromH(hfov, aspect) * Math.PI) / 180;
              const f = fitDriverEyeFrame(alliance, role, h, pts, aspect, cap);
              const centred = driverEyeFollow(f, pts, null, aspect);
              for (let gx = -60; gx <= 60; gx += 30) {
                for (let gy = -60; gy <= 60; gy += 30) {
                  const aim = driverEyeFollow(f, pts, { x: gx, y: gy, z: 0 }, aspect);
                  cases++;
                  if (!pointsInFrame(f.eye, aim.yaw, aim.pitch, f.vFov, aspect, pts)) {
                    lost++;
                    if (lostAt.length < 4) lostAt.push(`${alliance} ${role} h${h} a${aspect.toFixed(2)} fov${hfov} (${gx},${gy})`);
                  }
                  if (Math.abs(aim.yaw - centred.yaw) + Math.abs(aim.pitch - centred.pitch) > 0.01) turned++;
                }
              }
            }
          }
        }
      }
    }
    check(
      '⚠️ driverEye/field: the WHOLE FIELD and both HIVES are in frame wherever the robot is — every role, height, screen and lens',
      lost === 0,
      `${lost}/${cases} frames lost a point${lostAt.length ? ': ' + lostAt.join(', ') : ''}`,
    );
    check(
      'driverEye/field: ...and it is not a fixed view: the aim turns toward the robot in most of those frames',
      turned > cases / 2,
      `${turned}/${cases} turned`,
    );
    // the eye stays the player's own height and role; only the distance back from the wall moves
    const f = fitDriverEyeFrame('red', 'TOP', 68, pts, 16 / 9, (vFovFromH(100, 16 / 9) * Math.PI) / 180);
    const at = driverEyePoint('red', 'TOP', 68);
    check(
      "driverEye/field: the eye keeps the player's own height and role, and only steps straight back from the wall",
      f.eye.z === at.z && f.eye.y === at.y && Math.abs(f.eye.x) >= Math.abs(at.x) && f.extraBack >= 0,
      `eye ${JSON.stringify(f.eye)} vs ${JSON.stringify(at)}, ${f.extraBack.toFixed(1)} in further back`,
    );
    // ⚠️ CONTINUITY — the choppiness report. Drive the robot off its own wall in half-inch steps and
    // across the field: no step may turn the view more than a fraction of a degree. The first
    // version switched between two aims on a projection test and jumped several degrees here.
    let worst = 0;
    const cap = (vFovFromH(100, 16 / 9) * Math.PI) / 180;
    for (const alliance of ['red', 'blue'] as const) {
      const g = fitDriverEyeFrame(alliance, 'TOP', 68, pts, 16 / 9, cap);
      const sx = alliance === 'red' ? 1 : -1;
      for (const y of [-40, 0, 40]) {
        let prev = driverEyeFollow(g, pts, { x: -sx * 62, y, z: 0 }, 16 / 9);
        for (let d = 0.5; d <= 124; d += 0.5) {
          const cur = driverEyeFollow(g, pts, { x: -sx * 62 + sx * d, y, z: 0 }, 16 / 9);
          worst = Math.max(worst, Math.abs(cur.yaw - prev.yaw), Math.abs(cur.pitch - prev.pitch));
          prev = cur;
        }
      }
    }
    check(
      '⚠️ driverEye/field: the aim is CONTINUOUS — a half-inch of robot travel never turns the view more than 0.3°',
      worst < (0.3 * Math.PI) / 180,
      `worst ${((worst * 180) / Math.PI).toFixed(3)}° per half inch`,
    );
  }

  // ---- graphics/ still imports neither three nor scene/ ---------------------------------------
  {
    const src = readFileSync(join(BIOBUZZ_DIR, 'graphics', 'driverEye.ts'), 'utf8');
    check('driverEye/source: graphics/driverEye.ts does not import three', !/from\s+['"]three['"]/.test(src));
    check('driverEye/source: graphics/driverEye.ts does not import scene/', !/from\s+['"]\.\.\/scene\//.test(src));
  }

  // ---- WIRING: scene/renderCameras.ts's actual driver camera --------------------------------
  {
    const cams = createCameras();
    // a real BIOBUZZ world (`harness.ts`'s own fixture) rather than a hand-built stub — its one
    // robot is id 0, blue, and this block only ever moves its `pos`/`z`.
    const world = mkWorld('practice', 1);
    const robot = world.robots[0];
    robot.pos = { x: 20, y: 30 };

    // no height set ⇒ the driver pose is unaffected by role data being present or absent at all
    setDriverHeightIn(null);
    cams.update(frameFor({ localRobotId: undefined, localStartCat: undefined }), world, 'driver');
    const posUnset = cams.driver.position.clone();
    cams.update(frameFor({ localRobotId: robot.id, localStartCat: 'close' }), world, 'driver');
    const posUnsetWithRobot = cams.driver.position.clone();
    check(
      'driverEye/wiring: with no height set, the driver pose is byte-identical whether a local robot/role is present or not (the legacy pose)',
      posUnset.equals(posUnsetWithRobot),
      `${posUnset.toArray()} vs ${posUnsetWithRobot.toArray()}`,
    );
    check('driverEye/wiring: with no height set, the driver camera actually moved to a real pose (else the check above is vacuous)', posUnset.length() > 1);

    // height set + a resolvable TOP/BOTTOM role ⇒ the camera lands EXACTLY on driverEyePoint's
    // own answer, and nowhere near the un-set (fit-based) pose.
    setDriverHeightIn(68);
    robot.pos = { x: 10, y: -5 };
    cams.update(frameFor({ localRobotId: robot.id, localStartCat: 'close' }), world, 'driver');
    const role = bbRoleLabel('close', robot.alliance);
    check('driverEye/wiring: bbRoleLabel resolves close+blue to TOP (sanity for the expectation below)', role === 'TOP', role);
    const expected = driverEyePoint(robot.alliance, role as DriverRole, 68);
    const got = cams.driver.position;
    check(
      "driverEye/wiring: with a height set, the driver camera stands at the player's own height and role, straight back from their wall",
      Math.abs(got.y - expected.y) < 1e-6 && Math.abs(got.z - expected.z) < 1e-6 && Math.abs(got.x) >= Math.abs(expected.x) - 1e-6,
      `${got.toArray()} vs ${JSON.stringify(expected)}`,
    );
    check('driverEye/wiring: the height-accurate pose is NOT the legacy pose (the fallback did not silently win)', !got.equals(posUnset));

    // an UNRESOLVABLE role (no locked start category) falls back to the legacy pose too.
    setDriverHeightIn(68);
    cams.update(frameFor({ localRobotId: robot.id, localStartCat: undefined }), world, 'driver');
    check(
      "driverEye/wiring: height set but no locked role ⇒ falls back to the legacy pose (bbRoleLabel(undefined) is '-')",
      cams.driver.position.equals(posUnset),
      String(cams.driver.position.toArray()),
    );

    // the lens is the player's FOV setting now (horizontal), not a fixed 55° vertical
    setCameraTuning(90, 'full');
    cams.update(frameFor({ localRobotId: robot.id, localStartCat: 'close' }), world, 'driver');
    check(
      'driverEye/wiring: the height-accurate camera takes its lens from the FOV setting, for this screen',
      Math.abs(cams.driver.fov - vFovFromH(90, cams.driver.aspect)) < 1e-6,
      `${cams.driver.fov} vs ${vFovFromH(90, cams.driver.aspect)}`,
    );

    // clean up module-scope state so no other lane in this same process observes it.
    setCameraTuning(null, 'full');
    setDriverHeightIn(null);
  }
}

/**
 * THE GRAPHICS SETTINGS (Day 3, `docs/biobuzz/plan-3d.md` §4.4-§4.7).
 *
 * All of it is either PURE (the preset table, the pixel budget, Auto's policy, the HDRI
 * catalogue) or a SOURCE assertion, for the same reason the rest of this lane is: a settings
 * model that decides what a GPU is asked to do can be checked without a GPU, and the parts that
 * cannot be (does a shadow map actually reallocate) are what the manual pass is for.
 */
function graphicsChecks(check: Check, allFiles: string[]): void {
  const GRAPHICS_DIR = join(BIOBUZZ_DIR, 'graphics');
  const graphicsFiles = allFiles.filter((p) => p.startsWith(GRAPHICS_DIR + '\\') || p.startsWith(GRAPHICS_DIR + '/'));

  // ---- the settings MODEL never reaches for a renderer ------------------------------------
  //
  // `graphics/` is imported by `src/ui/GraphicsSection.tsx` and by `src/contributors.ts`, both
  // of which are ordinary main-bundle screens. One `import * as THREE` in here would put the
  // whole renderer in the bundle a DECODE player downloads - the exact regression the scene
  // boundary above exists to prevent, one directory over.
  check('graphics/ has files (else every check below is vacuous)', graphicsFiles.length > 0, String(graphicsFiles.length));
  const threeInGraphics = graphicsFiles.filter((f) => /from\s+['"]three['"]/.test(readFileSync(f, 'utf8')));
  check('nothing under graphics/ imports three.js', threeInGraphics.length === 0, threeInGraphics.map(relPosix).join(', '));
  const sceneFromGraphics = graphicsFiles.filter((f) => /from\s+['"]\.\.\/scene\//.test(readFileSync(f, 'utf8')));
  check('nothing under graphics/ imports scene/', sceneFromGraphics.length === 0, sceneFromGraphics.map(relPosix).join(', '));

  // ---- the settings table, the load-bearing cells ----------------------------------------
  //
  // Not every cell - a table transcribed twice is a table that disagrees with itself twice as
  // often. These are the ones a preset would be WRONG without: the four that define what each
  // tier is for, plus the two the plan hedges (see `GFX_NOT_OFFERED`).
  check('Low renders at 75 % and caps at 60 fps', GFX_PRESETS.low.renderScale === 75 && GFX_PRESETS.low.maxFps === 60);
  check('Low has no shadows at all', GFX_PRESETS.low.shadows === 'off' && GFX_PRESETS.low.elementShadows === 'none');
  check('Medium is the first tier with the high-detail mesh', GFX_PRESETS.medium.meshDetail === 'high' && GFX_PRESETS.low.meshDetail === 'low');
  check(
    'High is the first tier with an HDRI, env lighting and reflections',
    GFX_PRESETS.high.environment !== 'room' &&
      GFX_PRESETS.high.envLighting &&
      GFX_PRESETS.high.reflections &&
      GFX_PRESETS.medium.environment === 'room' &&
      !GFX_PRESETS.medium.envLighting,
  );
  check(
    'Ultra is soft shadows, 16x filtering and the full effects set',
    GFX_PRESETS.ultra.shadows === 'soft' && GFX_PRESETS.ultra.anisotropy === 16 && GFX_PRESETS.ultra.effects === 'full',
  );
  /**
   * ⚠️ **THE PiP MINIMAP IS OFF ON EVERY PRESET (owner, 2026-09-21).** It used to be ON at Low
   * and Medium, on the reasoning that the machines with the hardest-to-read 3D shot are the
   * ones that want a top-down aid. Two things were wrong with that: it is a SECOND FULL PASS
   * over the scene, which is the cost those machines can least afford, and it covers a corner
   * of the very field it is meant to help with. It stays one click away in Graphics.
   */
  check(
    'the PiP minimap is OFF on every preset — it is a second pass, and it covers the field',
    GFX_TIERS.every((t) => GFX_PRESETS[t].minimap === false),
    GFX_TIERS.map((t) => `${t}=${GFX_PRESETS[t].minimap}`).join(' '),
  );
  check('no preset turns on a feature this build does not implement (AO)', GFX_TIERS.every((t) => GFX_PRESETS[t].ao === 'off'));
  check(
    'every preset is exactly itself (matchesPreset is the `custom` test and must not misfire)',
    GFX_TIERS.every((t) => matchesPreset(GFX_PRESETS[t], t)) && !matchesPreset({ ...GFX_PRESETS.high, shadows: 'off' }, 'high'),
  );

  // ---- the pixel budget actually binds ---------------------------------------------------
  //
  // The whole point of the budget is the case the render-scale slider cannot reach on its own:
  // a big window on a HiDPI panel. At 2560x1440 CSS with a 2x device ratio and the slider at
  // 200 %, the naive answer is a 4x ratio - 59 megapixels a frame. Low's budget is 0.6.
  {
    const r = effectivePixelRatio({ ...GFX_PRESETS.low, renderScale: 200 }, 'low', 2560, 1440, 2);
    const px = 2560 * 1440 * r * r;
    check('the tier pixel budget caps a 200 % scale on a HiDPI panel', px <= GFX_PIXEL_BUDGET.low * 1.001, `${(px / 1e6).toFixed(2)} MP`);
    const ultra = effectivePixelRatio({ ...GFX_PRESETS.ultra }, 'ultra', 1280, 720, 1);
    check('a small window at 100 % is NOT capped (the budget is a ceiling, not a target)', Math.abs(ultra - 1) < 1e-9, String(ultra));
    check(
      'the budgets are the spec table\u2019s own four numbers',
      GFX_PIXEL_BUDGET.low === 0.6e6 && GFX_PIXEL_BUDGET.medium === 1.2e6 && GFX_PIXEL_BUDGET.high === 2.2e6 && GFX_PIXEL_BUDGET.ultra === 4.0e6,
    );
  }

  // ---- a frame cap that halves the frame rate is the classic way to make things worse -----
  check(
    'the 60 fps cap leaves slack for a 16.67 ms vsync (else every other frame is dropped)',
    frameIntervalMs(60) < 1000 / 60 && frameIntervalMs(60) > 15.5,
    frameIntervalMs(60).toFixed(2),
  );
  check('display means no cap at all', frameIntervalMs(0) === 0);

  // ---- the two sentinels, and the rate you type -------------------------------------------
  //
  // `maxFps` stopped being a union of literals when the owner asked for a typed rate
  // (2026-09-19), which makes it the one field in this settings object whose value arrives
  // from a TEXT BOX. Everything below is a shape the box can produce.
  {
    // Unlimited and VSync are the SAME instruction to the draw loop — skip nothing. The
    // difference is entirely whether the Electron shell was launched with
    // `disable-frame-rate-limit`, which nothing in this process can see or change.
    check(
      'both sentinels mean no cap at all in the loop (VSync and Unlimited)',
      frameIntervalMs(MAX_FPS_VSYNC) === 0 && frameIntervalMs(MAX_FPS_UNLIMITED) === 0,
    );
    check('the two sentinels cannot collide with a real rate', MAX_FPS_VSYNC === 0 && MAX_FPS_UNLIMITED === -1 && GFX_FPS_MIN > 0);
    check(
      'a typed rate keeps the same 0.5 ms of slack as a tile',
      Math.abs(frameIntervalMs(165) - (1000 / 165 - 0.5)) < 1e-12 && frameIntervalMs(165) > 0,
      frameIntervalMs(165).toFixed(3),
    );
  }
  {
    // A preset shipping Unlimited would turn vsync off on a machine nobody asked, and (on the
    // desktop) leave it off until somebody found this row again.
    check('no preset ships Unlimited', GFX_TIERS.every((t) => GFX_PRESETS[t].maxFps !== MAX_FPS_UNLIMITED));
    check(
      'every preset ships a value the picker can show as selected (a tile or a sentinel)',
      GFX_TIERS.every((t) => {
        const f = GFX_PRESETS[t].maxFps;
        return f === MAX_FPS_VSYNC || f === MAX_FPS_UNLIMITED || GFX_FPS_STEPS.includes(f);
      }),
    );
    check('the tiles are inside the typed range, so the two controls agree', GFX_FPS_STEPS.every((f) => f >= GFX_FPS_MIN && f <= GFX_FPS_MAX));
    check(
      'isCustomFps is exactly "a positive rate that is not a tile"',
      !isCustomFps(MAX_FPS_VSYNC) && !isCustomFps(MAX_FPS_UNLIMITED) && !isCustomFps(144) && isCustomFps(165),
    );
  }
  {
    // COERCION. The sentinels are matched exactly and first, so no clamp can ever produce one.
    const base = GFX_PRESETS.high.maxFps;
    check('coercion accepts both sentinels unchanged', coerceMaxFps(MAX_FPS_VSYNC, base) === MAX_FPS_VSYNC && coerceMaxFps(MAX_FPS_UNLIMITED, base) === MAX_FPS_UNLIMITED);
    check('a custom rate round-trips', coerceMaxFps(165, base) === 165);
    check(
      'out of range CLAMPS to the bound rather than reverting',
      coerceMaxFps(5, base) === GFX_FPS_MIN && coerceMaxFps(9999, base) === GFX_FPS_MAX,
      `${coerceMaxFps(5, base)}/${coerceMaxFps(9999, base)}`,
    );
    const junk: unknown[] = [NaN, Infinity, -Infinity, '60', 59.5, null, undefined, {}, true, -5];
    check('junk falls back to the base, every shape of it', junk.every((v) => coerceMaxFps(v, base) === base), String(junk.length));
    // -5 is in that list on purpose: an integer below zero that is not the sentinel is not a
    // cap under the floor, it is a corrupt value, and clamping it up to 24 would hand the
    // player a working cap they never chose.
    check('a negative that is not the sentinel does not clamp up into a real cap', coerceMaxFps(-5, base) === base);
  }
  {
    // the whole-object coercer routes through it, and an old stored blob still loads
    const out = coerceGraphicsSettings({ maxFps: 165 }, GFX_PRESETS.medium);
    check('the settings coercer takes a custom rate', out.maxFps === 165);
    check('a stored blob from the fixed-ladder build still loads', coerceGraphicsSettings({ maxFps: 240 }, GFX_PRESETS.medium).maxFps === 240);
    check('a stored blob with junk in it keeps the base rate', coerceGraphicsSettings({ maxFps: 'fast' }, GFX_PRESETS.low).maxFps === GFX_PRESETS.low.maxFps);
  }
  // ---- the slider, since the tile row is gone (owner ruling 2026-09-19) -------------------
  {
    check(
      'the slider round-trips every numeric stop, both directions',
      Array.from({ length: GFX_FPS_SLIDER_MAX - GFX_FPS_MIN + 1 }, (_, i) => GFX_FPS_MIN + i).every(
        (fps) => fpsFromSliderPos(sliderPosFromFps(fps), true, false) === fps,
      ),
    );
    check(
      'a typed rate past the slider ceiling still shows pinned at the top numeric stop, not off the track',
      sliderPosFromFps(GFX_FPS_MAX) === GFX_FPS_SLIDER_MAX && sliderPosFromFps(500) === GFX_FPS_SLIDER_MAX,
    );
    check('either sentinel draws the puck at the one no-cap stop', sliderPosFromFps(MAX_FPS_VSYNC) === GFX_FPS_SLIDER_NO_CAP && sliderPosFromFps(MAX_FPS_UNLIMITED) === GFX_FPS_SLIDER_NO_CAP);
    check(
      'the web can never drag its way to Unlimited — the no-cap stop is always VSync there, whatever it was asked to prefer',
      fpsFromSliderPos(GFX_FPS_SLIDER_NO_CAP, false, false) === MAX_FPS_VSYNC && fpsFromSliderPos(GFX_FPS_SLIDER_NO_CAP, false, true) === MAX_FPS_VSYNC,
    );
    check(
      'the desktop reaches Unlimited only by asking for it, and reaches VSync by not',
      fpsFromSliderPos(GFX_FPS_SLIDER_NO_CAP, true, true) === MAX_FPS_UNLIMITED && fpsFromSliderPos(GFX_FPS_SLIDER_NO_CAP, true, false) === MAX_FPS_VSYNC,
    );
    check(
      'a position below the no-cap stop never yields a sentinel, on either platform',
      [true, false].every(
        (isDesktop) => fpsFromSliderPos(GFX_FPS_SLIDER_MAX, isDesktop, true) !== MAX_FPS_VSYNC && fpsFromSliderPos(GFX_FPS_SLIDER_MAX, isDesktop, true) !== MAX_FPS_UNLIMITED,
      ),
    );
    check('the slider ceiling sits inside the typed range, so a drag and a typed value can agree', GFX_FPS_SLIDER_MAX >= GFX_FPS_MIN && GFX_FPS_SLIDER_MAX < GFX_FPS_MAX);
  }
  check('MSAA maps to a real sample count, and off means no render target', msaaSamples('off') === 0 && msaaSamples('msaa2') === 2 && msaaSamples('msaa4') === 4);
  check(
    'soft shadows reuse the high map size (they are a wider blur, not a fourth resolution)',
    shadowMapSize('soft') === shadowMapSize('high') && shadowMapSize('low') === 1024,
  );

  // ---- coercion: a stored blob from another build keeps what it can ------------------------
  {
    const stored = { shadows: 'off', aa: 'smaa', renderScale: 9999, hfov: 12, nonsense: true };
    const out = coerceGraphicsSettings(stored, GFX_PRESETS.high);
    check('coercion keeps a value it understands', out.shadows === 'off');
    check('coercion drops a value it does not (an `aa` from a build that offered SMAA)', out.aa === GFX_PRESETS.high.aa);
    check('coercion clamps rather than resets (render scale, FOV)', out.renderScale === 200 && out.hfov === 60, `${out.renderScale}/${out.hfov}`);
    // THE FOV SLIDER WENT HORIZONTAL (owner, 2026-09-24: "keep human fov in mind"). A blob from
    // before carries a VERTICAL `fov`: the old default becomes the new one (an untouched preset
    // still reads as that preset), anything else is what it showed across a 16:9 screen, and
    // nothing lands past what two human eyes see.
    const legacy = (fov: number): number => coerceGraphicsSettings({ fov }, GFX_PRESETS.high).hfov;
    check(
      'fov: a stored VERTICAL 70 (the old default) becomes the new default, and a stored 60 what it showed on 16:9',
      legacy(70) === GFX_PRESETS.high.hfov && legacy(60) === Math.round(hFovFromV(60, 16 / 9)),
      `70 -> ${legacy(70)}, 60 -> ${legacy(60)}`,
    );
    check(
      'fov: ...and a stored vertical 90 (121° across on 16:9) is held to the human binocular 120',
      legacy(90) === HUMAN_BINOCULAR_HFOV_DEG && HUMAN_BINOCULAR_HFOV_DEG === 120,
      String(legacy(90)),
    );
    check(
      'fov: vertical and horizontal convert both ways (100° across a 16:9 screen is ~67.6° tall)',
      Math.abs(vFovFromH(100, 16 / 9) - 67.67) < 0.05 && Math.abs(hFovFromV(vFovFromH(100, 16 / 9), 16 / 9) - 100) < 1e-6,
      vFovFromH(100, 16 / 9).toFixed(3),
    );
    check('coercion of nothing at all is the base preset', matchesPreset(coerceGraphicsSettings(undefined, GFX_PRESETS.medium), 'medium'));
  }

  // ---- the first guess, and the two steps -------------------------------------------------
  {
    const base: GpuProbe = { renderer: '', vendor: '', adapter: '', memoryGb: 16, cores: 12, dpr: 1, webgl2: true, software: false };
    check('a software renderer is Low whatever else it says', firstGuess({ ...base, renderer: 'Google SwiftShader', software: true }) === 'low');
    check('no WebGL2 is Low', firstGuess({ ...base, webgl2: false }) === 'low');
    check('a discrete GPU with memory and cores behind it starts at Ultra', firstGuess({ ...base, renderer: 'NVIDIA GeForce RTX 4070' }) === 'ultra');
    check('the same GPU on a thin machine starts at High', firstGuess({ ...base, renderer: 'NVIDIA GeForce RTX 4070', memoryGb: 4, cores: 4 }) === 'high');
    check(
      'an integrated GPU is Medium, and Low once it is pushing a HiDPI panel',
      firstGuess({ ...base, renderer: 'Intel(R) UHD Graphics 620' }) === 'medium' &&
        firstGuess({ ...base, renderer: 'Intel(R) UHD Graphics 620', dpr: 2 }) === 'low',
    );
    check(
      'an unrecognised string is not a guess, it is Medium/High by the machine around it',
      firstGuess({ ...base, renderer: '', cores: 2, memoryGb: 2 }) === 'medium' && firstGuess(base) === 'high',
    );
    check('stepping clamps at both ends', stepTier('low', -1) === 'low' && stepTier('ultra', 1) === 'ultra' && stepTier('high', -1) === 'medium');
  }

  // ---- p95 is nearest-rank, and does not reorder the caller's buffer ----------------------
  {
    const samples = [5, 5, 5, 5, 5, 5, 5, 5, 5, 40];
    const copy = [...samples];
    check('p95 of ten samples is the worst one', p95(samples) === 40, String(p95(samples)));
    check('p95 does not mutate its input', samples.every((v, i) => v === copy[i]));
    check('p95 of nothing is 0, not NaN', p95([]) === 0);
    check('the three warm-up/slip thresholds are the spec\u2019s three numbers', WARMUP_DOWN_MS === 16.7 && WARMUP_UP_MS === 6 && SLIP_MS === 25);
  }

  // ---- THE GOVERNOR, on an injected clock -------------------------------------------------
  //
  // This is the one piece of the graphics lane with real BEHAVIOUR in it, and it is also the
  // one piece that cannot be watched in a browser an agent drives: `requestAnimationFrame` only
  // fires when something forces a paint, so a scripted session never produces the steady stream
  // of frames a two-second warm-up is measuring. The clock is a parameter for exactly this
  // reason (see `createQualityGovernor`'s own note), so the policy is driven here instead:
  // frames in, preset changes out.
  //
  // ⚠️ THESE CHECKS WRITE THE SHARED SETTINGS STORE, which is module state for the process.
  // Every block restores it, and the last line of the section resets it outright.
  {
    /** feed `frames` samples of `ms` each, one per `stepMs` of simulated wall clock. */
    const drive = (gov: { sample(ms: number): void }, clock: { t: number }, frames: number, ms: number, stepMs = 16): void => {
      for (let i = 0; i < frames; i++) {
        clock.t += stepMs;
        gov.sample(ms);
      }
    };

    // a slow machine on Auto steps DOWN once the warm-up window closes
    {
      setGraphicsTier('high', true);
      const clock = { t: 0 };
      const gov = createQualityGovernor(() => clock.t);
      drive(gov, clock, 200, 30);
      check('warm-up: over the 60 Hz budget steps the preset DOWN one', getGraphics().tier === 'medium', getGraphics().tier);
      check('warm-up: and it is still Auto afterwards (a measurement is not a choice)', getGraphics().preset === 'auto');
    }

    // a fast machine steps UP
    {
      setGraphicsTier('medium', true);
      const clock = { t: 0 };
      const gov = createQualityGovernor(() => clock.t);
      drive(gov, clock, 200, 3);
      check('warm-up: comfortably inside the budget steps the preset UP one', getGraphics().tier === 'high', getGraphics().tier);
    }

    // a HAND-PICKED preset is not moved by detection
    {
      setGraphicsTier('ultra', false);
      const clock = { t: 0 };
      const gov = createQualityGovernor(() => clock.t);
      drive(gov, clock, 200, 40);
      check('warm-up: a hand-picked preset is left alone', getGraphics().tier === 'ultra' && getGraphics().preset === 'ultra');
    }

    // a warm-up with almost no frames in it decides nothing
    {
      setGraphicsTier('high', true);
      const clock = { t: 0 };
      const gov = createQualityGovernor(() => clock.t);
      drive(gov, clock, 8, 90, 300);
      check('warm-up: too few frames to be a measurement decides nothing', getGraphics().tier === 'high');
    }

    // THE SLIP RULE: sustained, once, with a line
    {
      setGraphicsTier('ultra', true);
      const clock = { t: 0 };
      const lines: string[] = [];
      const gov = createQualityGovernor(() => clock.t, (l) => lines.push(l));
      drive(gov, clock, 200, 8); // a clean warm-up first (8 ms is inside the up threshold)
      const afterWarmup = getGraphics().tier;
      drive(gov, clock, 60, 40); // ~1 s of 40 ms frames: over the threshold, not yet sustained
      const midSlip = getGraphics().tier;
      drive(gov, clock, 250, 40); // past SLIP_WINDOW_MS
      check('slip: a second of bad frames is not enough (that is a hiccup, not a machine)', midSlip === afterWarmup, `${afterWarmup} -> ${midSlip}`);
      check('slip: a sustained one lowers the preset', getGraphics().tier === stepTier(afterWarmup, -1), getGraphics().tier);
      const once = getGraphics().tier;
      drive(gov, clock, 600, 60);
      check('slip: and it fires ONCE, however bad it gets after', getGraphics().tier === once, getGraphics().tier);
      check('slip: it writes exactly one line, and the line says what happened', lines.filter((l) => /lowered/i.test(l)).length === 1, lines.join(' | '));
    }

    // A BACKGROUNDED TAB IS NOT A SLOW MACHINE (the stall guard)
    {
      setGraphicsTier('ultra', true);
      const clock = { t: 0 };
      const lines: string[] = [];
      const gov = createQualityGovernor(() => clock.t, (l) => lines.push(l));
      drive(gov, clock, 200, 8);
      const before = getGraphics().tier;
      // ten "frames" a second apart, each measuring the whole second away - what an alt-tabbed
      // or paint-gated tab hands the governor
      drive(gov, clock, 10, 1000, 1000);
      check('stall: a tab that was not being drawn does not lower anything', getGraphics().tier === before, `${before} -> ${getGraphics().tier}`);
      check('stall: and it writes no line either', lines.filter((l) => /lowered/i.test(l)).length === 0, lines.join(' | '));
      check('stall: the guard sits well past any frame a human would sit through', STALL_MS >= 250 && STALL_MS < SLIP_WINDOW_MS, String(STALL_MS));
    }

    check('the warm-up window is the spec\u2019s two seconds', WARMUP_MS === 2000);
    resetGraphicsToAuto();
  }

  // ---- the environments, and that every fetched one is credited ---------------------------
  {
    check('the procedural room is first and costs nothing', BB_ENVIRONMENTS[0].id === 'room' && !BB_ENVIRONMENTS[0].hdri);
    check('there are exactly two HDRI sets on this build', hdriEnvironments().length === 2, String(hdriEnvironments().length));
    for (const e of hdriEnvironments()) {
      const h = e.hdri!;
      check(`${e.id}: a 1k .hdr on Poly Haven\u2019s CDN, never a bundled copy`, /^https:\/\/dl\.polyhaven\.org\/.*_1k\.hdr$/.test(h.url), h.url);
      check(
        `${e.id}: CC0, with a licence link and at least one named author`,
        h.license === 'CC0 1.0' && h.licenseUrl.startsWith('https://') && h.authors.length > 0 && h.authors.every((a) => !!a.name && !!a.role),
      );
      check(`${e.id}: the picker states what the download costs`, h.bytes > 1e6 && h.bytes < 4e6 && /MB/.test(e.note), e.note);
    }
    check('an unknown environment id falls back to the room rather than throwing', environmentDef('nope' as never).id === 'room');
    // THE CREDIT IS DERIVED, so a third HDRI cannot ship uncredited. THIRD_PARTY now also
    // carries code/font/CAD credits (Contributors page, "Third-party" section), so this
    // checks that every HDRI has ITS row rather than that the two lists are the same length.
    check(
      'every fetched environment is on the Contributors page',
      hdriEnvironments().every((e) =>
        THIRD_PARTY.some((t) => t.name === e.name && t.license === 'CC0 1.0' && t.credits.length > 0),
      ),
    );
  }

  // ---- nothing bundles an HDRI, which is the one rule stated as a byte count ---------------
  {
    const bundled = allFiles.filter((f) => !f.endsWith('environments.ts') && /\.hdr['"]/.test(readFileSync(f, 'utf8')));
    check('no source file imports or embeds an .hdr (they are fetched, never shipped)', bundled.length === 0, bundled.map(relPosix).join(', '));
  }

  // ---- the SOURCE contracts the settings depend on ----------------------------------------
  {
    const sceneSrc = readFileSync(join(SCENE_DIR, 'renderScene.ts'), 'utf8');
    check('the scene subscribes to the settings (a change applies without a rebuild)', sceneSrc.includes('subscribeGraphics'));
    check(
      'the WebGL context is created with antialias:false - MSAA is the render target\u2019s, which is what makes it live',
      /antialias:\s*false/.test(sceneSrc) && sceneSrc.includes('WebGLRenderTarget'),
    );
    check('the shadow map is DISPOSED when its size changes (else low to high does nothing)', /this\.sun\.shadow\.map\?\.dispose\(\)/.test(sceneSrc));
    check('a software renderer selects the 2D view before it throws', sceneSrc.includes('fallBackTo2d()') && sceneSrc.includes('SceneUnsupportedError'));
    // STUCK ON 2D (tester report, 2026-09-23): a lost context or a failed probe used to STORE
    // '2d', so one GPU hiccup put the device on 2D for good. The fallback is per tab now.
    check('no scene code stores 2D on a failure (the fallback is per tab)', !sceneSrc.includes("setViewPref('2d')"));
    {
      const before = getViewPref();
      fallBackTo2d();
      const during = getViewPref();
      setViewPref('3d');
      const after = getViewPref();
      check('fallBackTo2d reads 2D for this tab, and picking 3D clears it', during === '2d' && after === '3d', `${before} → ${during} → ${after}`);
    }
    // the renderer ITSELF is built by `renderCore.ts`'s shared factory now (the builder preview
    // builds one the same way), so the attribute lives there — the `antialias: false` above is
    // still this file's own call site, which is the half that is a decision rather than plumbing.
    const coreSrc = readFileSync(join(SCENE_DIR, 'renderCore.ts'), 'utf8');
    check('a failed GPU probe is not cached (a retry can succeed without a reload)', /if \(probe\.webgl2 && !probe\.software\) cachedProbe = probe/.test(coreSrc));
    check('a disposed renderer frees its WebGL context now, not at GC', /forceContextLoss\(\)/.test(coreSrc) && sceneSrc.includes('releaseRenderer(this.renderer)'));
    check(
      'powerPreference high-performance on both the probe and the renderer',
      coreSrc.includes('high-performance') && readFileSync(join(GRAPHICS_DIR, 'auto.ts'), 'utf8').includes('high-performance'),
    );
    // ONE light rig, shared. The preview is not allowed to pick its own exposure or its own fill:
    // a robot lit differently in the builder than in the match is the drift roadmap item 1 names.
    check(
      'the light rig is CONSTANTS in renderCore.ts, not literals in either scene',
      /export const SCENE_EXPOSURE/.test(coreSrc) &&
        sceneSrc.includes('createSceneLights()') &&
        // the match scene's per-environment rig (2026-09-21) replaced its two `SCENE_HEMI_*`
        // reads; the constants are still the DEFAULT rig, which `BASE_RIG` copies — asserted
        // value-for-value by the environments block below.
        sceneSrc.includes('applyEnvironmentRig(') &&
        !/new THREE\.HemisphereLight\(/.test(sceneSrc),
    );

    const moduleSrc = readFileSync(join(root, 'src', 'games', 'module.ts'), 'utf8');
    check(
      'GameSceneFactory takes OPTIONAL options (additive: an existing one-argument caller is unchanged)',
      /options\?: SceneOptions/.test(moduleSrc) && /onQualityEvent\?\(line: string\)/.test(moduleSrc),
    );

    // the view key cannot live in the scene - that is the bug it was moved out to fix
    const keySrc = readFileSync(join(GRAPHICS_DIR, 'viewKey.ts'), 'utf8');
    check('the view key is outside the scene and toggles BOTH ways', keySrc.includes("=== '3d' ? '2d' : '3d'"));
    check('the scene no longer binds `t` itself (it could only ever go 3D to 2D)', !/case 't':/.test(sceneSrc));
    check('one shared listener, reference-counted (three hosts may hold it at once)', keySrc.includes('refs++') && keySrc.includes('attachedTo'));

    const replaySrc = readFileSync(join(root, 'src', 'ui', 'ReplayView.tsx'), 'utf8');
    check('the export menu picks a view and a camera', replaySrc.includes('exportView') && replaySrc.includes('exportCam') && replaySrc.includes("'chase'"));
    check('a 3D export is fixed at High and binds no input', replaySrc.includes("quality: 'high'") && replaySrc.includes('interactive: false'));
    check(
      'the 3D export composites scene, then the overlay, then both onto the frame, then the burn-in',
      replaySrc.indexOf('scene.render(shot.world, sceneFrame)') <
        replaySrc.indexOf('rend.render(overlayCtx, shot.world, null, localId, true)') &&
        replaySrc.indexOf('rend.render(overlayCtx, shot.world, null, localId, true)') < replaySrc.indexOf('drawImage(scene.element') &&
        replaySrc.indexOf('drawImage(scene.element') < replaySrc.lastIndexOf('drawReplayHud'),
    );
    // ⚠️ THE ONE THAT SHIPPED BLACK FRAMES. `Renderer.render(..., overlayOnly)` opens with a
    // `clearRect` over the whole canvas — right for the live view, where the 2D canvas is a
    // separate sheet above the WebGL one, and fatal in an export if both aim at the same canvas.
    check(
      'the overlay pass has a canvas of its own (it CLEARS, and would wipe the 3D frame)',
      /overlayCtx\s*=\s*overlay\.getContext\('2d'\)/.test(replaySrc) && replaySrc.includes("ctx.drawImage(overlay, 0, 0)"),
    );

    const configureSrc = readFileSync(join(root, 'src', 'ui', 'Configure.tsx'), 'utf8');
    check('Configure routes a Graphics section', configureSrc.includes("'graphics'") && configureSrc.includes('GraphicsSection'));
    check(
      'the Graphics section is LAZY (16 3D settings are not in a DECODE player\u2019s bundle)',
      /lazy\(\(\) => import\('\.\/GraphicsSection'\)/.test(configureSrc),
    );

    const css = readFileSync(join(root, 'src', 'ui', 'styles.css'), 'utf8');
    // THE 3D OVERLAY IS NOT A SECOND READ-OUT ANY MORE. `.bb-gfxstat` sat at `top: 48px;
    // left: 12px` \u2014 on top of the event log at `top: 52px; left: 14px` \u2014 so the scene's
    // counters now go to `src/perfStats.ts` and are printed by the ONE display, `.perf-hud`,
    // in the opposite corner. The scrim clause is still the point of the check: this card
    // floats over a lit 3D background and takes the bands' own token rather than a literal.
    check(
      'the performance read-out has a style, and takes the HUD scrim\u2019s token rather than a second literal',
      css.includes('.perf-hud') && css.includes('.game-root.view-3d .status-wrap') && !css.includes('.bb-gfxstat {'),
    );
    check(
      'the 3D scene publishes its counters instead of drawing its own corner div over the event log',
      readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderStats.ts'), 'utf8').includes('publishRenderStats') &&
        !readFileSync(join(BIOBUZZ_DIR, 'scene', 'renderStats.ts'), 'utf8').includes('createElement'),
    );
    // THE GALLERY'S 3D STILLS share ONE scene across every cell. A browser caps live WebGL
    // contexts (Chrome at about 16) and this grid is 30-odd cells, so a scene per cell would
    // silently start dropping the oldest ones — the failure looks like "some cells went black",
    // which is exactly what a reviewer would report as a renderer bug.
    const gallerySrc = readFileSync(join(BIOBUZZ_DIR, 'Gallery.tsx'), 'utf8');
    check(
      'the gallery builds ONE 3D scene for the whole grid',
      /function use3dStillScene/.test(gallerySrc) && (gallerySrc.match(/f\(host, \{ quality/g) ?? []).length === 1,
      String((gallerySrc.match(/f\(host, \{ quality/g) ?? []).length),
    );
    check('and it reaches it through the module slot, never a direct scene import', gallerySrc.includes("moduleFor('biobuzz').scene"));
    check('a per-scene 3D camera is optional and defaults to orbit (the gallery/spectator shot)', /camera3d\?: /.test(readFileSync(join(BIOBUZZ_DIR, 'scenes.ts'), 'utf8')) && gallerySrc.includes("camera ?? 'orbit'"));

    // THE TOUCH LAYER's toggle: a button, not a `MobileLayout` key (that would be a field in
    // another lane's `src/types.ts` plus a settings migration, for a control pressed twice a
    // session), and only for the game that HAS a 3D view.
    const mobileSrc = readFileSync(join(root, 'src', 'ui', 'MobileControls.tsx'), 'utf8');
    check('the touch layer has a 2D/3D toggle, gated to BIOBUZZ', mobileSrc.includes('mobile-view-btn') && mobileSrc.includes("game === 'biobuzz'"));
    check('...and it is NOT a draggable layout key', !/['"]view['"]\s*:/.test(mobileSrc) && !mobileSrc.includes("L['view']"));
    check('the view key is armed for the whole match by the INPUT layer, not by the scene', readFileSync(join(root, 'src', 'input', 'input.ts'), 'utf8').includes('installViewKey()'));

    // ══ THE 3D ROBOT BUILDER (`docs/roadmap.md` item 1) ═══════════════════════════════════
    //
    // Item 1's stated risk is one sentence: "preview and match must not drift". Every check in
    // this block is that sentence turned into something a grep can refuse, because a preview that
    // has drifted looks exactly as convincing as one that has not — the whole point of the
    // feature is that a player trusts it, so nothing here can be left to a habit.
    {
      const previewSrc = readFileSync(join(SCENE_DIR, 'renderPreview.ts'), 'utf8');
      const robotsSrc = readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8');
      const slotSrc = readFileSync(join(BIOBUZZ_DIR, 'Preview3D.tsx'), 'utf8');
      // COMMENTS STRIPPED for the two rules below: both of them are about what the file DOES, and
      // this file's headers quote the very strings they forbid while explaining why.
      const slotCode = codeLines(join(BIOBUZZ_DIR, 'Preview3D.tsx')).join('\n');
      const bbMod = moduleFor('biobuzz');
      const builderSrc = readFileSync(join(BIOBUZZ_DIR, 'Builder.tsx'), 'utf8');
      const menuSrc = readFileSync(join(root, 'src', 'ui', 'Menu.tsx'), 'utf8');

      // ── ONE GENERATOR ────────────────────────────────────────────────────────────────────
      check(
        'renderRobots.ts EXPORTS buildRobotGroup (else the preview cannot share it)',
        /export function buildRobotGroup\(/.test(robotsSrc),
      );
      check(
        'the preview builds its robot with buildRobotGroup — the match\u2019s own generator',
        /import \{[^}]*buildRobotGroup[^}]*\} from '\.\/renderRobots'/.test(previewSrc) &&
          // the 4th argument is the TIER's wheel tessellation (`bbWheelDetail`, 2026-09-21) — the
          // one thing a preview may pass that the match does not, and it passes the same function
          previewSrc.includes('buildRobotGroup(spec, 1, alliance, builtWheelDetail)'),
      );
      // and it draws NOTHING of its own: a `new THREE.Mesh` in here would be the second drawing
      // of a robot that this whole design exists to not have. The floor disc is the one mesh the
      // preview owns, and it is not part of the robot.
      {
        const meshes = (previewSrc.match(/new THREE\.Mesh\(/g) ?? []).length;
        check('...and it builds no robot geometry of its own (one mesh: the floor disc)', meshes === 1, String(meshes));
      }

      // ── ONE REBUILD KEY ──────────────────────────────────────────────────────────────────
      // The thumbnail cache lives in the MAIN chunk and has to key on the same identity the
      // generator rebuilds on, without loading the scene chunk to ask. Two copies is exactly how
      // a cached thumbnail ends up showing the previous build.
      check(
        'the rebuild key is bbSpecKey, in ONE place, read by the generator and the thumbnail cache',
        !/function specKey\(/.test(robotsSrc) &&
          robotsSrc.includes('bbSpecKey(r.spec)') &&
          previewSrc.includes('bbSpecKey(next)') &&
          slotSrc.includes('bbSpecKey(spec)'),
      );
      // ⚠️ AND IT KEYS ON `teamNumber`, WHICH IS NOT A SHAPE. The ROBOT SIGNS rasterise the number
      // into their texture at BUILD time (R403), so from the day the signs started printing
      // `spec.teamNumber` it became part of the built geometry's identity: without it, editing
      // only the team number leaves the old number on both plates AND in the cached thumbnail.
      // Measured as a behaviour, not grepped — two specs differing in nothing else must not
      // collide.
      {
        const keyFor = (teamNumber: number): string =>
          bbSpecKey(bbCoerceSpec({ ...BB_DEFAULT_SPEC, teamNumber } as RobotSpec));
        const a = keyFor(19745);
        const b = keyFor(12345);
        const same = keyFor(19745);
        check('the rebuild key separates two builds that differ only in team number', a !== b, `${a} vs ${b}`);
        check('...and is stable for the same team number', a === same);
      }

      // ── THE COSMETIC CHASSIS COLOUR, AND THE ALLIANCE (the gap item 1 names) ─────────────
      // 2D has always been fill = `chassisFill(chassisColor)`, alliance = the outline. 3D filled
      // the chassis with the ALLIANCE and never rendered `chassisColor` at all, so a supporter's
      // colour vanished the moment they pressed `t`. This is the fix, pinned.
      check(
        'the 3D chassis is FILLED with chassisFill(spec.chassisColor), the 2D allowlist',
        // the named import, not the whole line: `INTAKE_RAIL_T` joined it when the intake arms
        // became a truss, and pinning the line spelling made this fail for an unrelated reason
        /import \{[^}]*\bchassisFill\b[^}]*\} from '\.\.\/\.\.\/\.\.\/config';/.test(robotsSrc) &&
          robotsSrc.includes('solidMat(chassisFill(spec.chassisColor)'),
      );
      check(
        // the red/blue silhouette line is GONE, and so is the dark halo that sat under it (owner,
        // 2026-09-21, twice: "...the robot now just has a black outline. fix this"). A 3D robot
        // carries NO drawn edge line at all.
        '...and the ALLIANCE is the ROBOT SIGNS only: no edge line round the chassis, never the fill',
        !/new THREE\.LineSegments\(/.test(robotsSrc) &&
          !/outlineHalo|:outline`/.test(robotsSrc) &&
          robotsSrc.includes('getSignTexture(bbRobotSignText(spec), alliance)') &&
          !/chassisGeometry\([^)]*\), solidMat\(color/.test(robotsSrc),
      );

      // ══ THE ROBOT SIGN (§12.4 — R401, R402, R403) ════════════════════════════════════════
      //
      // Owner, 2026-09-19, items 1-3: two signs, not one; follow the real ROBOT SIGN rules; and
      // the number on the plate must be the ROBOT'S team number. The rule text is quoted in
      // `renderRobots.ts`'s own header and every number below is the manual's, not a taste call:
      //
      //   R401  minimum TWO per ROBOT, in >= 2 separate locations on opposite or adjacent
      //         surfaces; minimally 6.5 in wide and 2.5 in tall; supported by the structure.
      //   R402  a SOLID red or blue opaque rectangle >= 6.5 x 2.5 in, and visible markings other
      //         than the R403 number, fasteners, corner/fold/cutout slivers and template marks
      //         are PROHIBITED -- which is why the old white border is gone.
      //   R403  solid opaque WHITE Arabic numerals approx 2.25 in tall, >= 0.25 in of background
      //         round them, never vertically stacked (Fig 12-10 also rules mirrored text out).
      //
      // What shipped before: ONE square placard `min(3.6, length * 0.3)` on the LEFT plate only,
      // with a white stroked frame, printing the robot's SLOT INDEX (`String(id)`, 0..3). Every
      // one of the three rules was broken, and the number was not the team's.
      {
        // -- (1) TWO SIGNS, ONE PER SIDE ------------------------------------------------------
        check(
          'R401: the robot carries TWO ROBOT SIGNS, named left and right',
          robotsSrc.includes("[[1, 'left'], [-1, 'right']] as const") &&
            robotsSrc.includes('sign.name = `robot:${id}:sign:${where}`'),
        );
        check(
          '...on OPPOSITE surfaces, mirrored across the chassis centreline',
          robotsSrc.includes('sign.position.set(0, side * (spec.width / 2 + 0.05), BB_PLATE_H * 0.5)'),
        );
        check('...and the single-placard spelling is gone', !/robot:\$\{id\}:sign`/.test(robotsSrc));

        // -- (2) THE RULED DIMENSIONS ---------------------------------------------------------
        // Against the RULE's floors, which are exported beside the plate, not against a literal
        // copied out of the renderer -- the same reason the tape and plate rectangles are.
        check(`R401.B/R402: the plate is at least 6.5 in wide (${BB_SIGN_W})`, BB_SIGN_W >= BB_SIGN_MIN_W, `${BB_SIGN_W}`);
        check(`R401.C/R402: ...and at least 2.5 in tall (${BB_SIGN_H})`, BB_SIGN_H >= BB_SIGN_MIN_H, `${BB_SIGN_H}`);
        check(
          'R403.A+B: the height is EXACTLY the 2.25-in digits plus 0.25 in of background top and bottom',
          Math.abs(BB_SIGN_H - (BB_SIGN_DIGIT_H + 2 * BB_SIGN_MARGIN)) < 1e-9 && BB_SIGN_DIGIT_H === 2.25 && BB_SIGN_MARGIN === 0.25,
          `${BB_SIGN_H} = ${BB_SIGN_DIGIT_H} + 2 x ${BB_SIGN_MARGIN}`,
        );
        // the rule is an ABSOLUTE size in inches. A sign that scaled with the chassis was under
        // the legal minimum on every build in the game, and would go on being under it.
        check(
          '...and the plate does NOT scale with the chassis (the old `min(3.6, spec.length * 0.3)`)',
          !robotsSrc.includes('spec.length * 0.3') && robotsSrc.includes('new THREE.PlaneGeometry(BB_SIGN_W, BB_SIGN_H)'),
        );
        // and it FITS: the smallest chassis this builder can make is 11 x 10 in, and the side
        // plate it mounts on is `BB_PLATE_H` tall.
        {
          const minLen = Math.min(...(['sloped', 'vector', 'triangle'] as const).map((s) => lengthLimits(s).min));
          check(
            'a 6.5 x 2.75 sign fits the SMALLEST legal chassis side plate',
            BB_SIGN_W <= minLen && BB_SIGN_H <= BB_DECK_Z,
            `${BB_SIGN_W} <= ${minLen} long, ${BB_SIGN_H} <= ${BB_DECK_Z} tall`,
          );
        }

        // -- R402: NOTHING ON THE PLATE BUT THE NUMBER ----------------------------------------
        // The old 6-px white `strokeRect` is not one of R402's four permitted markings. Scoped
        // to the texture builder, because the file legitimately strokes other things.
        {
          const at = robotsSrc.indexOf('function getSignTexture(');
          const body = at < 0 ? '' : robotsSrc.slice(at, robotsSrc.indexOf('\n}', at));
          check('R402: the sign texture strokes nothing (the white border was a prohibited marking)', body.length > 0 && !/stroke/i.test(body));
          check('R402: ...and the whole plate is the solid alliance fill', body.includes("alliance === 'blue' ? BLUE : RED") && body.includes('ctx.fillRect(0, 0, canvas.width, canvas.height)'));
          check('R403.A: ...with WHITE numerals on it', body.includes("ctx.fillStyle = '#ffffff'"));
          check('R403.C: ...on ONE line, never stacked', (body.match(/fillText\(/g) ?? []).length === 1);
        }

        // -- Fig 12-10: NOT MIRRORED ----------------------------------------------------------
        // Measured on the BASIS, not grepped: a mirrored sign is a rule violation the old Euler
        // spelling (`rotation.set(PI/2, PI, 0)` plus a pre-flipped canvas) made invisible.
        for (const side of [1, -1] as const) {
          const m = new THREE.Matrix4().makeRotationFromQuaternion(bbRobotSignOrientation(side));
          const x = new THREE.Vector3().setFromMatrixColumn(m, 0);
          const y = new THREE.Vector3().setFromMatrixColumn(m, 1);
          const z = new THREE.Vector3().setFromMatrixColumn(m, 2);
          const det = new THREE.Vector3().crossVectors(x, y).dot(z);
          const tag = side > 0 ? 'left' : 'right';
          check(`Fig 12-10 (${tag}): the sign basis is a PROPER rotation, so the digits are not mirrored`, Math.abs(det - 1) < 1e-9, `det ${det.toFixed(6)}`);
          check(`R401 (${tag}): ...it faces outward`, Math.abs(z.y - side) < 1e-9 && Math.abs(z.x) < 1e-9 && Math.abs(z.z) < 1e-9, `n=(${z.x},${z.y},${z.z})`);
          check(`R403 (${tag}): ...and it is upright, so the number is not on its side`, Math.abs(y.z - 1) < 1e-9, `up=(${y.x},${y.y},${y.z})`);
        }
        check('the pre-mirrored canvas hack is gone with it', !/ctx\.scale\(-1, 1\)/.test(robotsSrc));

        // -- (3) THE NUMBER IS THE TEAM'S -----------------------------------------------------
        // It printed `String(id)`, the robot's SLOT in the match (0..3). §12.4: a ROBOT SIGN
        // "identifies a ROBOT'S team number".
        check('the sign no longer prints the robot slot index', !robotsSrc.includes('getSignTexture(id,'));
        for (const [n, want] of [[19745, '19745'], [1, '1'], [186033, '186033']] as const) {
          check(`the sign prints spec.teamNumber (${n})`, bbRobotSignText({ teamNumber: n }) === want, bbRobotSignText({ teamNumber: n }));
        }
        // and the unset case matches what the 2D team card does rather than printing a literal 0,
        // which would read as a real team number
        for (const n of [0, -3, Number.NaN] as const) {
          check(`teamNumber ${n} renders the 2D card's '-', not a digit`, bbRobotSignText({ teamNumber: n }) === '-', bbRobotSignText({ teamNumber: n }));
        }
        check(
          "...and that is the same test the 2D card makes (`teamNumber ? '#'+n : '-'`)",
          readFileSync(join(root, 'src', 'ui', 'GameView.tsx'), 'utf8').includes("{p.teamNumber ? `#${p.teamNumber}` : '-'}"),
        );
      }

      // ══ ITEM A -- "THE INTAKE SIDE PLATE IS MESHING WITH CHASSIS" ════════════════════════
      //
      // MEASURED, not guessed: `bbMouths` makes every mouth EXACTLY as wide as the chassis, at
      // every intake preset and every mount. So an arm mounted at `f.half - armT/2` puts its
      // outer face precisely ON the side plate's outer face -- and `armX0 = f.rail - 1.1` runs it
      // 1.1 in back inside the frame, so the two solids overlap for 1.1 in with co-planar outer
      // faces. That is the repo's own documented z-fight ("a co-planar line and surface flicker
      // per pixel per frame, which reads as a rendering fault"), at 1.1 in instead of a line.
      {
        let sites = 0;
        let flush = 0;
        for (const intake of ['sloped', 'vector', 'triangle'] as const) {
          for (const mount of ['front', 'back', 'left', 'right'] as const) {
            const base = BB_DEFAULT_SPEC as unknown as { bbMech: Record<string, unknown> };
            const spec = bbCoerceSpec({ ...BB_DEFAULT_SPEC, intake, bbMech: { ...base.bbMech, intakeMount: mount } } as never);
            for (const m of bbMouths(spec)) {
              const f = bbMouthFrame(m, spec.length / 2, spec.width / 2);
              const chassisHalf = m.edge === 'front' || m.edge === 'back' ? spec.width / 2 : spec.length / 2;
              sites++;
              if (Math.abs(f.half - chassisHalf) < 1e-9) flush++;
            }
          }
        }
        check('the mouth is exactly as wide as the chassis at EVERY preset and mount (the hazard)', sites > 0 && flush === sites, `${flush}/${sites}`);
        check(
          '...so the arm is set inboard of the frame line rather than sharing its outer face',
          robotsSrc.includes('arm.position.set(0, s * (f.half - BB_INTAKE_ARM_INSET - armT / 2), 0)') &&
            !robotsSrc.includes('arm.position.set(0, s * (f.half - armT / 2), 0)'),
        );
        // the inset has to CLEAR the plate, not merely be non-zero: flush against the plate's
        // inner face is still two coincident faces.
        check(
          '...by more than the outer plate is thick, so the two faces are genuinely apart',
          BB_INTAKE_ARM_INSET > 0.22,
          `${BB_INTAKE_ARM_INSET.toFixed(3)} in vs a 0.22-in plate`,
        );
        // ...and not so far that the arm stops reading as the mouth's own side
        check('...and by less than half an inch, so the mouth still reads its own width', BB_INTAKE_ARM_INSET < 0.5, `${BB_INTAKE_ARM_INSET}`);
      }

      // ══ ITEM B -- THE HOOD IS CARRIED, NOT FLOATING ══════════════════════════════════════
      //
      // Owner: "the hood is way too high up and it looks disconnected from the shooter."
      //
      // FIRST, IT IS NOT A PREVIEW ARTIFACT. `pitches[0].rotation.y` is written ONLY by the match
      // sync, so the preview's pitch node sits at its BUILD value of 0 -- which is
      // `BB_TURRET_PITCH_MIN`, i.e. the resting match pose. The preview and a resting match robot
      // are the same picture, so what the close-up found is real geometry.
      {
        check('the preview shows the RESTING match pose (its pitch node is never written)', BB_TURRET_PITCH_MIN === 0, `${BB_TURRET_PITCH_MIN}`);
        check(
          '...because only the match sync writes it',
          (robotsSrc.match(/pitches\[\d\]\.rotation\.y = -\(r\./g) ?? []).length === 2 && !previewSrc.includes('rotation.y'),
        );

        // THE GEOMETRY, run rather than grepped. `sidePlateR` is not exported (it is an internal
        // profile), so this measures the BUILT parts.
        //
        // ⚠️ **AND WHAT REACHES THE HOOD IS THE HOOD'S OWN CHEEK, NOT THE FIXED PLATE.** Two
        // passes grew the fixed plate up to `hoodR` to close this gap, and the owner rejected both
        // ("the shooter parallel plates became ugly. remember that the arc does not need to be
        // big") — because a plate sized to the hood is sized to a part that swings away from it,
        // and at the 80° cap it is left standing as a bare fin. The cheeks are on the PITCH node,
        // so they close the gap at EVERY elevation instead of at one.
        const H = bbHead(0);
        const hoodInner = H.hoodR;
        // the plate's reach, sampled round the profile off the built turret
        const turret = buildTurret(BB_DEFAULT_SPEC, 'front', 0);
        turret.updateMatrixWorld(true);
        let plate: THREE.Mesh | null = null;
        let hood: THREE.Mesh | null = null;
        let cheek: THREE.Mesh | null = null;
        turret.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          if (o.name === 'bb-turret-side-plate' && !plate) plate = o;
          if (o.name === 'bb-turret-hood' && !hood) hood = o;
          if (o.name === 'bb-turret-hood-cheek' && !cheek) cheek = o;
        });
        check('the turret builds a side plate, a hood and a cheek (else the next checks are vacuous)', plate !== null && hood !== null && cheek !== null);
        if (plate && hood && cheek) {
          const pBox = new THREE.Box3().setFromObject(plate);
          const hBox = new THREE.Box3().setFromObject(hood);
          const cBox = new THREE.Box3().setFromObject(cheek);
          check(
            'the CHEEK reaches the hood — the gap the owner saw is closed by the thing that moves',
            cBox.max.z >= hBox.max.z - 1e-3 && cBox.min.z <= BB_TURRET_AXLE_Z,
            `cheek z ${cBox.min.z.toFixed(3)}…${cBox.max.z.toFixed(3)} spans the axle ${BB_TURRET_AXLE_Z.toFixed(3)} to the hood top ${hBox.max.z.toFixed(3)}`,
          );
          check(
            '...and the FIXED plate went back to hugging the wheel rather than chasing the hood',
            Math.abs(pBox.max.z - (BB_TURRET_AXLE_Z + BB_SIDE_PLATE_TOP_Z)) < 1e-3,
            `plate top ${(pBox.max.z - BB_TURRET_AXLE_Z).toFixed(3)} above the axle — the cut, not hoodR ${hoodInner.toFixed(3)}`,
          );
          // THE EXIT IS STILL RELIEVED. The plate must not climb in FRONT of the lip, which is
          // what the flat top was for: forward of the axle it stays at the corridor cut.
          const forwardTop = Math.max(
            ...[0, 10, 20, 30, 45, 60, 80].map((deg) => {
              const th = (deg * Math.PI) / 180;
              // the profile's own forward branch, restated: min(hoodR, TOP/sin, FRONT/cos)
              let r = hoodInner;
              if (Math.sin(th) > 1e-9) r = Math.min(r, 0.96732 / Math.sin(th));
              if (Math.cos(th) > 1e-9) r = Math.min(r, 2.2 / Math.cos(th));
              return Math.sin(th) * r;
            }),
          );
          check(
            'forward of the axle the plate is still cut to the outgoing corridor',
            forwardTop < 1.0,
            `${forwardTop.toFixed(3)} in above the axle`,
          );
        }
        disposeRobotGroup(turret);

        // ⚠️ BOTH ATTEMPTS AT GROWING THE FIXED PLATE ARE GONE BY NAME, so neither can come back
        // as a "small" edit: the 22° relief ramp of the first, and the rear rake of the second.
        check('no BB_HOOD_RELIEF ramp is left to tune', !robotsSrc.includes('BB_HOOD_RELIEF'));
        check('...and no rear rake either — the fixed profile is the arc-and-box it always was', !robotsSrc.includes('rearRake'));
        check(
          'the hood hangs on SOLID cheeks, not on spokes — no radialBar left in the file',
          !robotsSrc.includes('radialBar') && robotsSrc.includes("cheek.name = 'bb-turret-hood-cheek'"),
        );
        // ⚠️ AND THE MUZZLE CONTRACT IS UNTOUCHED -- the SHOOTER block above proves the drawn lip
        // sits on `bbMuzzleLocal` at every pitch. These two say the constants it reads did not
        // move to get this picture.
        check('the release chain did not move for this (BB_LAUNCH_Z0)', BB_LAUNCH_Z0 === 10, `${BB_LAUNCH_Z0}`);
        check(
          '...and `BB_SIDE_PLATE_TOP_Z` is still the corridor cut it always was',
          Math.abs(BB_SIDE_PLATE_TOP_Z - (BB_FLYWHEEL_R - 0.3 - 0.15)) < 1e-9,
          `${BB_SIDE_PLATE_TOP_Z.toFixed(5)}`,
        );
        check('...and nothing outside this renderer reads it', !readFileSync(join(BIOBUZZ_DIR, 'robot.ts'), 'utf8').includes('BB_SIDE_PLATE_TOP_Z'));
      }

      // ══ ITEM C -- THE CHASSIS COLOUR HAS TO BE THERE FROM ABOVE ══════════════════════════
      //
      // Owner: "chassis color change is not noticeable enough. The top needs to change." The
      // cosmetic mesh was the four side plates -- VERTICAL surfaces, presenting a 0.22-in edge
      // from straight above and nothing else. The file header CLAIMED the deck carried the
      // colour; the code put the deck in the structural part and said so on the line.
      //
      // Measured on the built frame: the UPWARD-FACING area of the cosmetic mesh. That is the
      // invariant, not "the deck is in the skin now" -- a future rearrangement is free, as long
      // as a top-down camera still sees the colour.
      {
        const upArea = (spec: RobotSpec, cosmetic: boolean): number => {
          const parts = buildFrame(spec);
          const mesh = parts.find((p) => p.name === (cosmetic ? 'robot:frame:skin' : 'robot:frame:rails')) as THREE.Mesh | undefined;
          if (!mesh) return 0;
          const pos = mesh.geometry.getAttribute('position');
          const idx = mesh.geometry.getIndex();
          const n = idx ? idx.count : pos.count;
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          const c = new THREE.Vector3();
          const e1 = new THREE.Vector3();
          const e2 = new THREE.Vector3();
          const nn = new THREE.Vector3();
          let area = 0;
          for (let t = 0; t < n; t += 3) {
            const ia = idx ? idx.getX(t) : t;
            const ib = idx ? idx.getX(t + 1) : t + 1;
            const ic = idx ? idx.getX(t + 2) : t + 2;
            a.fromBufferAttribute(pos, ia);
            b.fromBufferAttribute(pos, ib);
            c.fromBufferAttribute(pos, ic);
            e1.subVectors(c, b);
            e2.subVectors(a, b);
            nn.crossVectors(e1, e2);
            const len = nn.length();
            if (len <= 0) continue;
            if (nn.z / len > 0.9) area += len / 2; // faces up
          }
          return area;
        };
        for (const dt of ['mecanum', 'swerve'] as const) {
          const spec = bbCoerceSpec({ ...BB_DEFAULT_SPEC, drivetrain: dt } as never);
          const up = upArea(spec, true);
          const foot = spec.length * spec.width;
          check(
            `${dt}: the chassis colour presents real upward-facing area (it was ~0)`,
            up > 60,
            `${up.toFixed(1)} sq in of ${foot.toFixed(0)} footprint`,
          );
          check(`${dt}: ...at least a quarter of the footprint`, up / foot > 0.25, `${((up / foot) * 100).toFixed(0)} %`);
          // THE TOP PLATE COVERS THE WHOLE CHASSIS, WHEELS INCLUDED (owner, 2026-09-21). This used
          // to assert the opposite — an inset deck, under 75 % of the footprint, "not a slab" — and
          // that ruling is reversed: from above, no wheel pocket may be open.
          check(`${dt}: the top plate covers the whole chassis, wheels included`, up / foot >= 0.99, `${((up / foot) * 100).toFixed(0)} %`);
        }
        check('the deck is cosmetic now, and the header says why', robotsSrc.includes('WHAT CARRIES THE COSMETIC COLOUR, AND WHY IT CHANGED'));
        check('there is a cosmetic top cap on each side plate', /const BB_TOP_CAP_W = /.test(robotsSrc) && robotsSrc.includes('sy * (hw - BB_TOP_CAP_W / 2), BB_PLATE_H + BB_TOP_CAP_T / 2'));
        // and the ALLIANCE must not have moved into the cosmetic path -- G414 is a rules matter
        check(
          'the ALLIANCE is still the outline and the signs, never the fill',
          !/lineMat\(chassisFill/.test(robotsSrc) && !/getSignTexture\([^)]*chassisColor/.test(robotsSrc),
        );
      }

      // ── THE IMPORT BOUNDARY, FOR THE ONE COMPONENT THAT REACHES A LAZY CHUNK ─────────────
      // `Preview3D.tsx` is in the MAIN chunk (the builder is a menu screen). A static import of
      // the scene, or of `three`, would put Three.js in a DECODE player's bundle.
      check(
        'Preview3D.tsx imports no three, and no scene/ module',
        !/from\s+['\"]three['\"]/.test(slotSrc) && !/from\s+['\"]\.\/scene/.test(slotSrc),
      );
      check(
        '...and reaches the renderer ONLY through the module slot',
        slotCode.includes("moduleFor('biobuzz').previewScene") && !/\bimport\(/.test(slotCode),
      );
      // the thumbnails are DERIVED data and are never written to storage: they would be the
      // biggest thing in localStorage and would go stale, plausibly, the day the generator changed
      check('thumbnails are cached in memory only, never persisted', !slotCode.includes('localStorage'));
      // and the preview must not rewrite the app's view preference the way the MATCH scene does —
      // a menu card quietly changing what the next match renders with would be a surprise
      check('the preview scene does not touch the view preference', !previewSrc.includes('setViewPref'));

      // ── THE SLOTS, AND THE HOSTS THAT FILL THEM ──────────────────────────────────────────
      check('biobuzz fills previewScene, and it is a function', typeof bbMod.previewScene === 'function');
      check(
        'decode and chain do NOT (no 3D generator for either)',
        moduleFor('decode').previewScene === undefined && moduleFor('chain').previewScene === undefined,
      );
      check('biobuzz fills the savedThumb slot', typeof bbMod.savedThumb === 'function');
      check(
        'the builder hero opts INTO a live scene; the strategy cards do not',
        menuSrc.includes('allow3d') &&
          !readFileSync(join(root, 'src', 'ui', 'MatchStrategy.tsx'), 'utf8').includes('allow3d'),
      );
      check('Menu hands the savedThumb slot to the saved-robot card', menuSrc.includes('<SavedThumb spec={r}'));
      // A PICTURE ON EVERY SAVED ROBOT, in every game (owner, 2026-09-23): a game with no
      // savedThumb gets the hero's 2D schematic, and BIOBUZZ's slot draws its own schematic
      // whenever it has no 3D render (2D view, still rendering, or a machine that cannot)
      check(
        '...and a game with no savedThumb still gets a 2D picture on the card',
        menuSrc.includes('<span className="ds-robot-card-thumb">{preview2d(r,'),
      );
      check(
        'the BIOBUZZ thumbnail falls back to the 2D schematic, never to nothing',
        slotCode.includes("pref === '3d' && url ? <img") && slotCode.includes('<BiobuzzRobotPreview spec={spec} size={88}'),
      );
      // ENTERING THE PAGE: the thumbnail batch must not stack a second WebGL setup on the live
      // turntable's (measured ~130 of ~210 ms of long tasks), and the first build's shaders
      // compile off the main thread (`compileAsync`) before anything captures or draws
      check(
        'the thumbnail batch starts on idle and captures one per idle slice, after `ready()`',
        slotCode.includes('void idle().then(drain)') &&
          !slotCode.includes('Promise.resolve().then(drain)') &&
          slotCode.includes('await scene.ready()') &&
          slotCode.includes('await idle()'),
      );
      check(
        'the preview scene warms its shaders with compileAsync and draws nothing until then',
        previewSrc.includes('.compileAsync(scene, camera)') && previewSrc.includes('if (!warm ||'),
      );
      // DECODE's sprite preview builds its template world ONCE: `createWorld` runs the G304 start
      // search (~30 ms a call), and a hero plus three saved cards made it a 276 ms long task
      check(
        'the DECODE robot preview builds one template world per document, not one per picture',
        readFileSync(join(root, 'src', 'ui', 'RobotPreview.tsx'), 'utf8').includes('template ??= createWorld('),
      );
      // the name and the team are one line each and scroll rather than wrap, on the card and in
      // the pinned hero — the results roster's own marquee, not a second one
      check(
        'robot cards and the hero put the name and team through the shared Marquee',
        readFileSync(join(root, 'src', 'ui', 'RobotCard.tsx'), 'utf8').includes('<Marquee text={spec.name') &&
          menuSrc.includes('<Marquee text={spec.name') &&
          readFileSync(join(root, 'src', 'ui', 'Results.tsx'), 'utf8').includes('<Marquee text={p.name}'),
      );
      // the picture sits BESIDE the name and never replaces the build line: a thumbnail that did
      // not render used to leave a tall card with nothing on it but a name (owner, 2026-09-22)
      check(
        '...and the thumbnail is the card’s picture, not its body',
        readFileSync(join(root, 'src', 'ui', 'RobotCard.tsx'), 'utf8').includes('{thumb}') &&
          !slotCode.includes('bbConfigSummary'),
      );
      // THE HERO'S 3D FAILURE is a segment state, not a sentence in the 96px preview column —
      // the sentence widened the column until the robot's name was cut to "My Ro…"
      check(
        'a preview that cannot start marks the 3D segment (.off + title), with no visible sentence',
        slotCode.includes("failed ? ' off' : ''") && !slotCode.includes('<p className="ds-hint">'),
      );

      // ── THE HEIGHT PAIR (R102 / R105.A) ──────────────────────────────────────────────────
      check(
        'the builder has a heightIn dial over BB3_HEIGHT_MIN..MAX (the coercer\u2019s own range)',
        builderSrc.includes('heightIn: Number(e.target.value)') &&
          builderSrc.includes('min={BB3_HEIGHT_MIN}') &&
          builderSrc.includes('max={BB3_HEIGHT_MAX}'),
      );
      check(
        '...and no stow declaration: the dial stops at the 18-in cube, so nothing has to fold',
        BB3_HEIGHT_MAX <= BB3_STOW_MAX && !builderSrc.includes('stowHeightIn'),
        `BB3_HEIGHT_MAX ${BB3_HEIGHT_MAX}, BB3_STOW_MAX ${BB3_STOW_MAX}`,
      );
      // the preview's stow toggle is the SAME resolver the rule reads, expressed as a spec whose
      // height IS the stow height — which is what makes the group rebuild for free
      check(
        'the preview\u2019s stow toggle shows bbStowHeightIn, and only for a folding build',
        slotSrc.includes('bbStowHeightIn(spec)') &&
          slotSrc.includes('{ ...spec, heightIn: stowHeight }') &&
          slotSrc.includes('deployed > BB3_STOW_MAX'),
      );
    }

    // ══ LANE B — THE ROBOT MODEL (owner playtest 2026-09-18: #9 too tall, #16 the drivetrain,
    // #10 the launcher, #14 the intake reach) ═════════════════════════════════════════════════
    //
    // All four complaints were the same mistake: the COLLIDER was being drawn instead of the
    // robot. The checks below pin the four statements that stop it coming back. Three are source
    // greps (this lane has no DOM and may not import `three`); the fourth is real arithmetic over
    // the sim's own geometry, which is where the intake reach actually lives.
    {
      const robotsSrc = readFileSync(join(SCENE_DIR, 'renderRobots.ts'), 'utf8');
      const robotsCode = codeLines(join(SCENE_DIR, 'renderRobots.ts')).join('\n');

      // ── #9 / #16: A LOW DRIVETRAIN, NOT A FULL-HEIGHT SLAB ───────────────────────────────
      // ⚠️ `BB_DECK_Z`, NOT A LITERAL SCRAPED OUT OF THE RENDERER. The deck moved into
      // `config.ts` with the rest of the turret's stack (2026-09-19), and `BB_PLATE_H` is now an
      // alias for it — a regex for `= 4.6;` reads NaN and every number below it comes out NaN,
      // which is how a check quietly stops checking.
      const plateH = BB_DECK_Z;
      check(
        'the drivetrain has its own height, and it is a drivetrain height',
        plateH > 3 && plateH < 6 && plateH < BB3_HEIGHT_MIN / 2,
        String(plateH),
      );
      // the slab is gone: nothing extrudes or boxes a solid of `height` any more, and the wheels
      // no longer scale with it (they used to be `min(2.5, height * 0.25)`)
      check(
        '...and nothing builds a solid the height of the robot',
        !/chassisGeometry\(/.test(robotsCode) && !/height \* 0\.25/.test(robotsCode),
      );
      check(
        'buildWheels reads the SPEC only — a taller robot does not get bigger wheels',
        // `accent` (the cosmetic tint, `docs/cosmetics-plan.md` §3.4) is not a size term, so the
        // regex allows it without weakening what this pins.
        /function buildWheels\(spec: RobotSpec, accent: string[^)]*\): BbWheels/.test(robotsSrc),
      );
      // ⚠️ A ROBOT'S VISUAL HEIGHT IS WHATEVER ITS MECHANISMS REACH (owner, 2026-09-18). The first
      // answer to #9 carried `heightIn` as an open two-post mast, which is the same complaint in a
      // thinner shape — a goalpost standing on the deck for no apparent reason. The generator now
      // reads no height at all, and the ONE place the declared height is shown is the builder
      // turntable, as a dashed envelope that is visibly a measurement rather than a part.
      check(
        'the generator reads no height at all — it cannot draw one',
        !/heightIn/.test(robotsCode) && !/BB3_HEIGHT_DEFAULT/.test(robotsCode),
      );
      // ...AND THE VISUAL STILL FITS INSIDE THE COLLIDER. The tallest thing the generator builds
      // is the shooter's side plate, whose top is fixed by the muzzle height and the hood chain —
      // it does not vary with the chassis — so one sum covers every build, and it is checked
      // against the SHORTEST legal robot rather than against the default. (The built group is at
      // rest pitch, which is what this measures; a hood ELEVATED past level legitimately swings
      // above the frame, the same way real hardware does inside R105's expanded volume.)
      {
        // ⚠️ MEASURED OFF THE BUILT GROUP, NOT RE-DERIVED FROM SCRAPED LITERALS. The version this
        // replaces reconstructed the chain (`BB_FLYWHEEL_R` + `BB_HOOD_COMPRESSION` +
        // `BB_PLATE_R_OUT`) out of the renderer's source with three regexes, and when that chain
        // moved into `config.ts` every one of them read NaN — a check that stops checking without
        // ever going red. It also named the wrong part: the tallest thing at rest is the HOOD now,
        // not the side plate, because the plate deliberately stops below it (owner item b).
        const probe = buildTurret({ ...BB_DEFAULT_SPEC }, 'center');
        probe.updateMatrixWorld(true);
        const shooterTop = new THREE.Box3().setFromObject(probe).max.z;
        disposeRobotGroup(probe);
        check(
          'the tallest drawn part still fits inside the SHORTEST legal collider',
          Number.isFinite(shooterTop) && shooterTop <= BB3_HEIGHT_MIN,
          `${shooterTop.toFixed(2)} in vs ${BB3_HEIGHT_MIN}`,
        );
        check(
          '...and the default height leaves air above it rather than being the reason for it',
          shooterTop < BB3_HEIGHT_DEFAULT,
          `${shooterTop.toFixed(2)} in vs ${BB3_HEIGHT_DEFAULT}`,
        );
      }
      {
        const previewCode = codeLines(join(SCENE_DIR, 'renderPreview.ts')).join('\n');
        check(
          'the BUILDER shows it instead, as a dashed envelope off the same resolver the rule reads',
          previewCode.includes('bbDeployedHeightIn(spec)') &&
            previewCode.includes('LineDashedMaterial') &&
            previewCode.includes("line.name = 'bb-height-envelope'"),
        );
        check(
          '...and it is framed, removed and freed with the group rather than by a second path',
          previewCode.includes('group.add(buildHeightEnvelope(spec));'),
        );
      }

      // ── #16: TWO PARALLEL PLATES A SIDE, WHEELS BETWEEN THEM, FOOTPRINT UNCHANGED ────────
      check(
        'the OUTER plate face is the frame line, so the footprint is still length x width',
        robotsCode.includes('const outerY = hw - BB_PLATE_T / 2;') &&
          robotsCode.includes('const innerY = hw - BB_PLATE_T * 1.5 - BB_PLATE_GAP;'),
      );
      check(
        'the wheels sit in the channel BETWEEN the two plates',
        robotsCode.includes('const wheelY = spec.width / 2 - BB_PLATE_T - BB_PLATE_GAP / 2;') &&
          /const BB_PLATE_GAP = BB_WHEEL_W \+ /.test(robotsCode),
      );
      check('cross members, a belly pan and a deck — a frame, not a box', /CROSS MEMBERS/.test(robotsSrc) && /BELLY PAN/.test(robotsSrc));

      // ── THE SHOOTER: BUILT, POSED AND MEASURED — NOT GREPPED ────────────────────────────
      //
      // ⚠️ **EVERYTHING BELOW USED TO BE A STRING CHECK OVER `renderRobots.ts`, AND IT PASSED
      // FIVE TIMES ON GEOMETRY THE OWNER REJECTED.** It asserted three literals that were all
      // present, all consistent with each other, and all describing a machine with the flywheel
      // hung three inches in the air, side plates reaching over the hood, and a flap on the back.
      // A lane that greps cannot see a shape. This one BUILDS the real `buildTurret` group, poses
      // `bb-turret-pitch` through the whole elevation envelope, and measures VERTICES.
      //
      // ⚠️ AND IT MEASURES **BOTH HEADS**. Owner item (d) of 2026-09-19 is that a NECTAR shooter
      // is a different size from a POLLEN one, so every measurement here runs twice against the
      // head's own `bbHead(which)` rather than once against a single set of constants. A check
      // that only ever sees turret 0 cannot see a NECTAR head at all.
      //
      // That is why this file imports `three` — the only script in the lane that does. The
      // chunk-boundary rules at the top of this function are about `src/`; a Node smoke script is
      // not bundled, and `buildTurret` touches no DOM (the sign texture, which does, is in
      // `buildRobotGroup` and is not on this path).
      for (const which of [0, 1] as const) {
        const H = bbHead(which);
        const tag = which === 1 ? 'nectar' : 'pollen';
        const turret = buildTurret({ ...BB_DEFAULT_SPEC }, 'center', which);
        const root = new THREE.Group();
        root.add(turret);
        const axleNode = turret.userData.axle as THREE.Group;
        const pitchNode = turret.userData.pitch as THREE.Group;
        const exitNode = pitchNode.getObjectByName('bb-turret-exit');
        const axleInv = new THREE.Matrix4();
        /** put the turret at elevation `p` and refresh both frames we measure in. */
        const pose = (p: number): void => {
          pitchNode.rotation.y = -p;
          root.updateMatrixWorld(true);
          axleInv.copy(axleNode.matrixWorld).invert();
        };
        const meshes: THREE.Mesh[] = [];
        turret.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
        });
        const named = (n: string): THREE.Mesh[] => meshes.filter((m) => m.name === n);
        const scratch = new THREE.Vector3();
        /** every vertex of `m`, in the ROBOT frame — z is height off the tiles, x is measured from
         *  the turret's own ROTATION AXIS (the group is built at `turretLocal('center')`). */
        const robotVerts = (m: THREE.Mesh): THREE.Vector3[] => {
          const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
          const out: THREE.Vector3[] = [];
          for (let i = 0; i < pos.count; i++) out.push(scratch.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
          return out;
        };
        /** …and in the AXLE frame, which is the fixed node's own frame and the one every θ in
         *  `config.ts` is measured in. It is NOT the yaw node's any more — the axle sits `axleX`
         *  forward of the rotation axis, which is the whole of owner item (b). */
        const axleVerts = (m: THREE.Mesh): THREE.Vector3[] =>
          robotVerts(m).map((v) => v.clone().applyMatrix4(axleInv));
        /**
         * ⚠️ THE TOLERANCE EVERY MEASUREMENT BELOW IS PAID AT, AND WHY IT IS NOT 1e-9. A
         * `BufferAttribute`'s positions are FLOAT32 — that is what goes to the GPU, so it is what
         * the picture actually is — and at these radii that is ~5e-7 of absolute error. Anything
         * tighter would be a check on double arithmetic the renderer never performs. The node
         * POSITIONS (the muzzle) are doubles and are held to 1e-9; only vertex readings pay this.
         */
        const F32 = 1e-4;
        /** the elevations every sweep below samples: the whole envelope, ends included. */
        const PITCHES = 41;
        const pitchAt = (i: number): number =>
          BB_TURRET_PITCH_MIN + ((BB_TURRET_PITCH_MAX - BB_TURRET_PITCH_MIN) * i) / (PITCHES - 1);

        pose(BB_TURRET_PITCH_MIN);
        /**
         * ⚠️ **AN EXACT LIST, NOT A SUBSET.** Owner item (c) of 2026-09-19 was "there is still a
         * weird flap in the back of the shooter that does nothing" — reported for the SECOND time,
         * against a part (the feed shoe) a previous pass had added on purpose. A check that only
         * asks "is every part I expect present" cannot see a part nobody can explain, so this one
         * also asks the other way round: every mesh on the shooter is on this list, and each name
         * says what the thing is for.
         */
        const PARTS = [
          'bb-turret-ring',
          'bb-turret-plate',
          'bb-turret-side-plate',
          'bb-turret-flywheel',
          'bb-turret-flywheel-hub',
          'bb-turret-shaft',
          'bb-turret-brace',
          'bb-turret-throat',
          'bb-turret-motor',
          'bb-turret-belt',
          'bb-turret-hood',
          'bb-turret-hood-cheek',
        ] as const;
        check(
          `${tag}: the shooter is an ASSEMBLY of named parts, and every one of them was built`,
          PARTS.every((n) => named(n).length > 0) && named('bb-turret-side-plate').length === 2 && named('bb-turret-hood-cheek').length === 2,
          PARTS.map((n) => `${n}×${named(n).length}`).join(' '),
        );
        check(
          `${tag}: ...and NOTHING ELSE is on it — no part without a job (the "weird flap", twice reported)`,
          meshes.every((m) => (PARTS as readonly string[]).includes(m.name)),
          [...new Set(meshes.map((m) => m.name).filter((n) => !(PARTS as readonly string[]).includes(n)))].join(', ') || 'clean',
        );

        // ══ ONLY THE HOOD AND ITS ARMS MOVE WITH PITCH ══════════════════════════════════════
        //
        // ⚠️ **THIS IS THE OWNER RULING THE LANE NEVER HAD.** "When the hood is changing angle,
        // the flywheel should be fixed and the parallel plates should be fixed. Only the hood, a
        // central arc in the back, should be moving up and down." Before the restructure
        // `bb-turret-pitch` carried the WHOLE shooter, and nothing said otherwise because the only
        // thing ever checked was where the pivot was written down.
        //
        // A part's fingerprint is its vertex extent in the ROBOT frame. Sampled over 41 pitches:
        // everything but the hood must not move by so much as a float, and the hood must.
        {
          const MOVES = ['bb-turret-hood', 'bb-turret-hood-cheek'];
          const print = (m: THREE.Mesh): THREE.Box3 => new THREE.Box3().setFromPoints(robotVerts(m));
          pose(BB_TURRET_PITCH_MIN);
          const base = new Map<THREE.Mesh, THREE.Box3>(meshes.map((m) => [m, print(m)]));
          const drift = new Map<THREE.Mesh, number>(meshes.map((m) => [m, 0]));
          for (let i = 1; i < PITCHES; i++) {
            pose(pitchAt(i));
            for (const m of meshes) {
              const b = print(m);
              const b0 = base.get(m) as THREE.Box3;
              drift.set(m, Math.max(drift.get(m) ?? 0, b.min.distanceTo(b0.min) + b.max.distanceTo(b0.max)));
            }
          }
          const worstFixed = Math.max(...meshes.filter((m) => !MOVES.includes(m.name)).map((m) => drift.get(m) ?? 0));
          const leastMoved = Math.min(...meshes.filter((m) => MOVES.includes(m.name)).map((m) => drift.get(m) ?? 0));
          check(
            `${tag}: ONLY the hood moves with elevation — wheel, plates, braces, motor, belt and throat do not`,
            worstFixed === 0,
            `worst drift ${worstFixed.toFixed(6)} in over ${PITCHES} pitches`,
          );
          check(
            `${tag}: ...and the hood and its two cheeks DO — they are on the pitch node, so this is not vacuous`,
            leastMoved > 1,
            `least-moved hood part travels ${leastMoved.toFixed(3)} in`,
          );
          check(
            `${tag}: ...and the pitch node carries NOTHING ELSE (three meshes: the arc and its two cheeks)`,
            pitchNode.children.filter((c) => (c as THREE.Mesh).isMesh).length === 3,
            pitchNode.children.map((c) => c.name || c.type).join(', '),
          );
        }

        // ══ THE CONTRACT: THE DRAWN LIP IS THE SIM'S MUZZLE, AT EVERY ELEVATION ═════════════
        //
        // ⚠️ THE WHOLE POINT OF THE DIMENSION CHAIN LIVING IN `config.ts`. `bbMuzzleLocal` is the
        // ONE function; the sim releases from it and this node is placed by it, so the picture and
        // the physics agree by construction rather than by two people keeping two numbers in step.
        // The old arrangement agreed at ONE pitch — which is exactly what the check it replaces
        // asserted, and why five rounds of disagreement got through.
        {
          let worst = 0;
          let where = '';
          for (let i = 0; i < PITCHES; i++) {
            const p = pitchAt(i);
            pose(p);
            const w = new THREE.Vector3();
            (exitNode as THREE.Object3D).getWorldPosition(w);
            const m = bbMuzzleLocal(p, which);
            // `back` is measured along the turret's heading from the ROTATION AXIS, which at zero
            // yaw is +x, so the drawn lip's x must be exactly `−back`
            const err = Math.hypot(w.x - -m.back, w.y, w.z - m.z);
            if (err > worst) {
              worst = err;
              where = `${((p * 180) / Math.PI).toFixed(1)}° drawn (${w.x.toFixed(4)}, ${w.z.toFixed(4)}) vs sim (${(-m.back).toFixed(4)}, ${m.z.toFixed(4)})`;
            }
          }
          check(`${tag}: the DRAWN hood lip is at bbMuzzleLocal(pitch) at EVERY elevation, not just at rest`, worst < 1e-9, `worst ${worst.toExponential(2)} in — ${where}`);
          pose(BB_TURRET_PITCH_MIN);
          const rest = new THREE.Vector3();
          (exitNode as THREE.Object3D).getWorldPosition(rest);
          pose(BB_TURRET_PITCH_MAX);
          const top = new THREE.Vector3();
          (exitNode as THREE.Object3D).getWorldPosition(top);
          check(
            `${tag}: ...and it is not a constant — the lip DROPS and comes BACK toward the axis as the hood elevates`,
            rest.z - top.z > 2 && rest.x > 2 && top.x < rest.x && top.x > -F32,
            `(${rest.x.toFixed(3)}, ${rest.z.toFixed(3)}) → (${top.x.toFixed(3)}, ${top.z.toFixed(3)}) — it was a flat ${BB_LAUNCH_Z0} over the mount at every pitch, which is what a DUMPER still has`,
          );
        }

        // ══ (b) THE ELEMENT COMES UP THE ROTATION AXIS AND MEETS THE WHEEL THERE ════════════
        //
        // ⚠️ **OWNER ITEM (b), 2026-09-19: "the flywheel should come forward more so that the
        // location where the balls contact the flywheel initially as it comes up is roughly in the
        // center of the turret".** Measured off the DRAWN wheel, not off the constant: the axle's
        // own x in the robot frame, and the pinch it puts on the axis.
        {
          pose(BB_TURRET_PITCH_MIN);
          const wheelVs = named('bb-turret-flywheel').flatMap((m) => robotVerts(m));
          const axleX = (Math.min(...wheelVs.map((v) => v.x)) + Math.max(...wheelVs.map((v) => v.x))) / 2;
          check(
            `${tag}: the DRAWN flywheel's axle is pathR FORWARD of the rotation axis`,
            Math.abs(axleX - H.axleX) < F32 && Math.abs(H.axleX - H.pathR) < 1e-12 && H.axleX > 2,
            `drawn axle x ${axleX.toFixed(4)} vs pathR ${H.pathR.toFixed(4)}`,
          );
          check(
            `${tag}: ...so the element, rising on x = 0, pinches on the axis and first touches the rim below it`,
            Math.abs(H.axleX - H.pathR) < 1e-12 && (BB_FLYWHEEL_R + H.elemR) ** 2 > H.axleX ** 2,
            `first contact ${(BB_TURRET_AXLE_Z - Math.sqrt((BB_FLYWHEEL_R + H.elemR) ** 2 - H.axleX ** 2)).toFixed(3)} in off the tiles, pinch at ${BB_TURRET_AXLE_Z.toFixed(3)}`,
          );
          // ...and the plate under it is CUT THROUGH, or the feed path is a claim and not a shape
          const plateVs = robotVerts(named('bb-turret-plate')[0]);
          const holeMin = Math.min(...plateVs.filter((v) => Math.abs(v.y) < H.slotHalfW - 0.3).map((v) => Math.hypot(v.x, v.y)));
          check(
            `${tag}: the turret plate is CUT THROUGH on the axis — the feed is a hole, not a claim`,
            holeMin > 0.5 && plateVs.some((v) => Math.abs(v.x - H.slotBackX) < F32) && plateVs.some((v) => Math.abs(v.x - H.slotFrontX) < F32),
            `nearest plate material to the axis ${holeMin.toFixed(3)}, slot x [${H.slotBackX.toFixed(2)}, ${H.slotFrontX.toFixed(2)}] ±${H.slotHalfW.toFixed(2)}`,
          );
        }

        // ══ THE HOOD IS PROUD OF THE SIDE PLATES, BY CONSTRUCTION ══════════════════════════
        //
        // "The arc in the parallel plates of the shooter reaches too high. The hood extends above
        // the supporting parallel plates." The plate's outer boundary is `config.ts`'s profile —
        // FIVE FLATS: the top at the corridor cut, the front past the standoffs, the bottom on the
        // turret plate, the rear at the motor's mount station, and the undercut between the last
        // two — and the hood occupies `hoodR … +BB_HOOD_T`.
        //
        // ⚠️ AND THE FIXED PLATE IS ONE PIECE, MOTOR MOUNT TO MUZZLE (owner, 2026-09-21: "the plate
        // in the back that mounts the motor and the plate that retains the flywheel should be the
        // same plate"). The ARC at `hoodR` that used to close the rear is gone with the split it
        // caused; the plate's TOP has not moved and neither has the ratchet below it, because
        // reaching BACKWARD to the motor is a different axis from the two passes that grew this
        // plate UP to chase the hood ("the shooter parallel plates became ugly. remember that the
        // arc does not need to be big"). What reaches the hood is still the hood's own CHEEK.
        // Restated here rather than imported, the way this lane always restates the profile, so
        // the two copies have to agree.
        const TH_EXIT = Math.PI / 2;
        const UNDER = ((): { nx: number; nz: number; c: number } => {
          const px = -(H.wallR + BB_FEED_WALL_T); // the feed wall's back face, on the bottom flat
          const pz = BB_SIDE_PLATE_BOTTOM_Z;
          const dx = -H.motorR - px;
          const dz = -pz;
          const d = Math.hypot(dx, dz);
          const ca = (BB_TURRET_MOTOR_R + BB_MOTOR_MOUNT_RIM) / d;
          const sa = Math.sqrt(1 - ca * ca);
          const nx = (dx * ca + dz * sa) / d;
          const nz = (-dx * sa + dz * ca) / d;
          return { nx, nz, c: nx * px + nz * pz };
        })();
        const plateR = (th: number): number => {
          const st = Math.sin(th);
          const ct = Math.cos(th);
          let r = Infinity;
          if (st > 1e-9) r = Math.min(r, BB_SIDE_PLATE_TOP_Z / st);
          if (st < -1e-9) r = Math.min(r, BB_SIDE_PLATE_BOTTOM_Z / st);
          if (ct > 1e-9) r = Math.min(r, BB_SIDE_PLATE_FRONT_X / ct);
          if (ct < -1e-9) r = Math.min(r, H.sideRearX / ct);
          const nu = UNDER.nx * ct + UNDER.nz * st;
          if (nu < -1e-9) r = Math.min(r, UNDER.c / nu);
          return r;
        };
        {
          // ⚠️ **THE STATEMENT IS A PARTITION NOW, AND THAT IS WHAT THE LONGER PLATE MADE IT.**
          // It used to be one clause — the hood is proud of the plate at every angle in the wrap,
          // at every elevation — which a plate ending at `hoodR` satisfied everywhere. A plate
          // that reaches the motor cannot: at θ = 180° it runs out to `sideRearX`, 2.0 in past the
          // hood's own swept disc, so at high elevation the hood's tail is radially INSIDE it.
          // That is not the bug the old clause was written for; it is what a hood between two
          // plates does. So the rule is the partition the geometry actually makes, and the two
          // branches MEET EXACTLY at sin θ = BB_SIDE_PLATE_TOP_Z / hoodR (165.7° on a POLLEN
          // head): either the hood stands BB_HOOD_T proud of the plate along that ray, or its arc
          // has dropped to or below the plate's flat top, where it is carried between the plates
          // and `BB_HOOD_SIDE_CLEAR` plus the 41-elevation interpenetration sweep are what hold it
          // off. Both branches must be NON-EMPTY, or a plate swallowing the hood would pass by
          // having no angle in the first branch at all.
          let worst = Infinity;
          let worstAt = '';
          let rest = Infinity;
          let proudN = 0;
          let underN = 0;
          let neither = '';
          const NA = 24;
          for (let i = 0; i < PITCHES; i++) {
            const p = pitchAt(i);
            for (let j = 0; j <= NA; j++) {
              const th = Math.PI / 2 + p + (BB_HOOD_WRAP * j) / NA;
              const proud = H.hoodR + BB_HOOD_T - plateR(th);
              if (proud >= BB_HOOD_T - 1e-9) {
                proudN++;
                if (proud < worst) {
                  worst = proud;
                  worstAt = `p=${((p * 180) / Math.PI).toFixed(1)}° θ=${((th * 180) / Math.PI).toFixed(1)}°`;
                }
              } else if (H.hoodR * Math.sin(th) <= BB_SIDE_PLATE_TOP_Z + 1e-9) underN++;
              else if (!neither) {
                neither = `p=${((p * 180) / Math.PI).toFixed(1)}° θ=${((th * 180) / Math.PI).toFixed(1)}°: proud ${proud.toFixed(4)}, hood arc at z ${(H.hoodR * Math.sin(th)).toFixed(4)} over the cut ${BB_SIDE_PLATE_TOP_Z.toFixed(4)}`;
              }
              if (i === 0) rest = Math.min(rest, proud);
            }
          }
          check(
            `${tag}: at every elevation the hood is either PROUD of the plate or below its flat top — never covered by it`,
            neither === '' && proudN > 0 && underN > 0,
            neither || `${proudN} angles proud (worst +${worst.toFixed(4)}, ${worstAt}), ${underN} below the cut`,
          );
          // …and the two ENDS of the envelope are each entirely in one branch, which is the shape
          // of the mechanism rather than an average over it.
          let restWorst = Infinity;
          let capHighest = -Infinity;
          for (let j = 0; j <= NA; j++) {
            const off = (BB_HOOD_WRAP * j) / NA;
            restWorst = Math.min(restWorst, H.hoodR + BB_HOOD_T - plateR(Math.PI / 2 + off));
            capHighest = Math.max(capHighest, H.hoodR * Math.sin(Math.PI / 2 + BB_TURRET_PITCH_MAX + off));
          }
          check(
            `${tag}: ...AT REST the whole wrap is proud of it, and AT THE 80° CAP the whole wrap has dropped under the cut`,
            restWorst >= BB_HOOD_T - 1e-9 && capHighest <= BB_SIDE_PLATE_TOP_Z + 1e-9,
            `rest worst +${restWorst.toFixed(3)}; at the cap the hood's arc tops out at ${capHighest.toFixed(3)} against the cut ${BB_SIDE_PLATE_TOP_Z.toFixed(3)}`,
          );
          // ⚠️ AND THE FIXED PLATE IS *NOT* WHAT CLOSES THE GAP. The clause that sat here for one
          // pass was `rest <= BB_HOOD_T`, i.e. "somewhere in the wrap the fixed plate comes right
          // up under the hood" — which is what grew the plate into a fin. The hood is carried by
          // its CHEEKS (measured below, at every elevation rather than at rest); the fixed plate
          // is free to stay compact, and this says it does.
          check(
            `${tag}: ...and the fixed plate does NOT chase it — at rest it stays below the corridor cut`,
            rest > 2.5,
            `the plate is +${rest.toFixed(3)} clear of the hood through the whole wrap; a plate grown to meet it reads +${BB_HOOD_T}`,
          );
          pose(BB_TURRET_PITCH_MIN);
          // the DRAWN hood: its vertices live in exactly the band the arithmetic above assumes
          const hoodR = axleVerts(named('bb-turret-hood')[0]).map((v) => Math.hypot(v.x, v.z));
          check(
            `${tag}: ...and the DRAWN hood really does occupy hoodR … +BB_HOOD_T (the arithmetic is about this mesh)`,
            Math.min(...hoodR) > H.hoodR - 1e-6 && Math.max(...hoodR) < H.hoodR + BB_HOOD_T + 1e-6,
            `${Math.min(...hoodR).toFixed(4)} … ${Math.max(...hoodR).toFixed(4)}`,
          );
          // the DRAWN plate: no vertex outside the profile, and the profile is actually reached
          let over = 0;
          let reach = 0;
          for (const v of axleVerts(named('bb-turret-side-plate')[0])) {
            const r = Math.hypot(v.x, v.z);
            const lim = plateR(Math.atan2(v.z, v.x));
            over = Math.max(over, r - lim);
            reach = Math.max(reach, r);
          }
          // the profile's own farthest point is the REAR-TOP corner now — the motor mount's outside
          // corner — where it used to be the arc at `hoodR`. Compared against the analytic max
          // rather than a literal, so the two copies still have to agree.
          // the corner itself, not a sample of it: a convex profile's farthest point is a vertex,
          // and no ray may pass it
          const profileMax = Math.hypot(H.sideRearX, BB_SIDE_PLATE_TOP_Z);
          let sampled = 0;
          for (let i = 0; i < 36000; i++) sampled = Math.max(sampled, plateR((Math.PI * 2 * i) / 36000));
          check(
            `${tag}: ...and the DRAWN side plate IS that profile: nothing outside it, and its far corner is reached`,
            over < 1e-6 && sampled <= profileMax + 1e-9 && Math.abs(reach - profileMax) < F32,
            `worst overshoot ${over.toExponential(2)}, max r ${reach.toFixed(4)} vs the rear-top corner (${H.sideRearX.toFixed(3)}, ${BB_SIDE_PLATE_TOP_Z.toFixed(3)}) at ${profileMax.toFixed(4)}; the profile's own sampled max ${sampled.toFixed(4)}`,
          );
        }

        // ══ THE PLATE'S TOP: UNDER THE HOOD, AND CUT AWAY IN FRONT OF THE EXIT ═════════════
        // The rest pose, deliberately: that is the configuration the ruling is about and the one a
        // robot sits in between shots. At full elevation the hood has swung BACK and DOWN, so the
        // fixed plate is legitimately the taller of the two — the all-elevation statement is the
        // RADIAL one above, which holds at every pitch.
        {
          pose(BB_TURRET_PITCH_MIN);
          const plateTop = Math.max(...robotVerts(named('bb-turret-side-plate')[0]).map((v) => v.z));
          const hoodTop = Math.max(...robotVerts(named('bb-turret-hood')[0]).map((v) => v.z));
          // ⚠️ THESE HAVE NOW PINNED THE BUG IN BOTH DIRECTIONS, AND THAT IS WHY THEY READ AS
          // THEY DO. First they asserted `plateTop < hoodTop - 3` — the plate stopping 3 in short
          // of the hood everywhere, i.e. owner item (B) written down as a requirement. Then they
          // asserted the opposite, `hoodTop - plateTop < 1` — which is the plate grown into a fin,
          // the thing the owner called ugly. Neither is the rule. The rule is that the FIXED plate
          // is the compact cut and the CHEEK is what reaches the hood, so what is pinned here is
          // the plate's own top being exactly `BB_SIDE_PLATE_TOP_Z` and nothing else.
          check(
            `${tag}: the fixed plate's top IS the corridor cut, at every angle — it is not sized to the hood`,
            Math.abs(plateTop - (BB_TURRET_AXLE_Z + BB_SIDE_PLATE_TOP_Z)) < 1e-3,
            `plate top ${(plateTop - BB_TURRET_AXLE_Z).toFixed(4)} above the axle vs the cut ${BB_SIDE_PLATE_TOP_Z.toFixed(4)}; the hood is up at ${(hoodTop - BB_TURRET_AXLE_Z).toFixed(3)}`,
          );
          check(
            `${tag}: ...and the hood is the topmost part of the assembly, well above it`,
            plateTop < hoodTop - BB_HOOD_T,
            `plate ${plateTop.toFixed(3)} vs hood ${hoodTop.toFixed(3)}`,
          );
          const fwdTop = Math.max(...axleVerts(named('bb-turret-side-plate')[0]).filter((v) => v.x > 0.05).map((v) => v.z));
          check(
            `${tag}: ...while forward of the axle it is still the flat cut BB_SIDE_PLATE_TOP_Z`,
            Math.abs(fwdTop - BB_SIDE_PLATE_TOP_Z) < 1e-3,
            `${fwdTop.toFixed(4)} vs ${BB_SIDE_PLATE_TOP_Z.toFixed(4)}`,
          );
        }

        // ══ AND THE FIXED PLATE STAYS COMPACT — A RATCHET ON ITS REACH ═════════════════════
        //
        // ⚠️ **OWNER, 2026-09-19, ON THE PASS THAT FIXED THE FLOATING HOOD: "the shooter parallel
        // plates became ugly. remember that the arc does not need to be big."** Two passes grew
        // this plate to reach the hood, and the 80° pose is where both showed: the hood swings
        // down behind the wheel and leaves the plate standing as a bare fin at `hoodR`. The
        // checks above pin the plate's TOP; this pins its REACH over the whole upper hemisphere,
        // which is the number a relief ramp, a raked tail or any other clever outline would have
        // to raise. It may get smaller, never bigger.
        {
          let reach = 0;
          let reachAt = 0;
          for (let i = 0; i <= 18000; i++) {
            const th = (Math.PI * i) / 18000;
            const r = plateR(th);
            if (r > reach) {
              reach = r;
              reachAt = th;
            }
          }
          // the arc at `hoodR` legitimately closes the REAR of the plate, where it is behind the
          // wheel and below the corridor — the bound is on how high that reach gets, which is the
          // flat top's own cut plus the chord a 0.75° sample can miss it by.
          check(
            `${tag}: over the upper hemisphere the fixed plate never reaches higher than the corridor cut`,
            reach * Math.sin(reachAt) <= BB_SIDE_PLATE_TOP_Z + 1e-6,
            `highest ${(reach * Math.sin(reachAt)).toFixed(4)} at θ=${((reachAt * 180) / Math.PI).toFixed(1)}° vs the cut ${BB_SIDE_PLATE_TOP_Z.toFixed(4)} (the ramp read 3.632, the rake 3.917)`,
          );
          const NS = 36000;
          const dth = (Math.PI * 2) / NS;
          let area = 0;
          for (let i = 0; i < NS; i++) {
            const r = plateR(i * dth);
            area += ((r * r) / 2) * dth;
          }
          // ½∮r²dθ is exact for a profile single-valued about the axle, which this one is by
          // construction (five half-planes with the axle inside them — convex).
          //
          // ⚠️ **RE-BASELINED 2026-09-21, ONCE, FOR THE OWNER'S ONE-PIECE RULING**: 16.2 → 21.41
          // POLLEN, 18.4 → 23.55 NECTAR, all of it the tail that reaches the motor. The rejected
          // shapes are NOT let back in by that — they were rejected for reaching UP, and the check
          // above this one (the upper hemisphere never rises above the corridor cut, which the
          // ramp read 3.632 and the rake 3.917 against) is what holds them out, unchanged. This
          // stays a ratchet on the plate's total size at the new outline.
          const AREA_MAX = which === 1 ? 23.7 : 21.6;
          check(
            `${tag}: ...and its silhouette stays under ${AREA_MAX} sq in`,
            area <= AREA_MAX,
            `${area.toFixed(2)} sq in (the compact plate that could not reach the motor was ${which === 1 ? '18.4' : '16.2'}; the ramp ${which === 1 ? '28.80' : '22.80'}, the rake ${which === 1 ? '26.80' : '20.83'})`,
          );
        }

        // ══ THE HOOD AND ITS CHEEKS ARE ONE RIGID ASSEMBLY ON THE AXLE ═════════════════════
        //
        // ⚠️ **THIS IS WHAT REPLACED "grow the fixed plate".** The hood's arc cannot bolt to
        // anything fixed, because it elevates; what a real adjustable hood has is a pair of CHEEK
        // plates that are part of it — a pivot boss on the shooter axle and a solid sector out to
        // the hood's own outer face. Because they are on `bb-turret-pitch`, the hood is carried at
        // EVERY elevation rather than at rest, which is the failure both plate-growing passes had
        // at the 80° cap. "The arc does not need to be big" is the sector's own size rule.
        {
          pose(BB_TURRET_PITCH_MIN);
          const cheeks = named('bb-turret-hood-cheek');
          const cv = cheeks.map((m) => axleVerts(m));
          const rs = cv.flat().map((v) => Math.hypot(v.x, v.z));
          check(
            `${tag}: each cheek runs from a boss ON the axle out to the hood's own outer face`,
            cheeks.length === 2 && Math.min(...rs) <= 0.05 && Math.abs(Math.max(...rs) - (H.hoodR + BB_HOOD_T)) < F32,
            `r ${Math.min(...rs).toFixed(4)} … ${Math.max(...rs).toFixed(4)} vs the hood's outer face ${(H.hoodR + BB_HOOD_T).toFixed(4)}`,
          );
          // THE SECTOR IS NO WIDER THAN THE ARC IT CARRIES. Everything past the boss — the radius
          // at which a sector is a sector rather than a hub — must lie inside the hood's own wrap.
          const hub = 0.75;
          let span = 0;
          let spanAt = '';
          for (const v of cv.flat()) {
            const r = Math.hypot(v.x, v.z);
            if (r <= hub + F32) continue;
            const th = Math.atan2(v.z, v.x);
            const off = Math.max(TH_EXIT - th, th - (TH_EXIT + BB_HOOD_WRAP));
            if (off > span) {
              span = off;
              spanAt = `θ=${((th * 180) / Math.PI).toFixed(1)}° at r=${r.toFixed(2)}`;
            }
          }
          check(
            `${tag}: ...and the sector is no wider than the wrap it carries — "the arc does not need to be big"`,
            span <= 1e-3,
            span <= 1e-3 ? `inside [90°, ${(((TH_EXIT + BB_HOOD_WRAP) * 180) / Math.PI).toFixed(1)}°] everywhere past the boss` : `${((span * 180) / Math.PI).toFixed(2)}° outside it — ${spanAt}`,
          );
          // ONE ASSEMBLY: the cheek's inner face IS the hood's side face, so the two are flush
          // rather than two parts near each other. Lateral, because that is the only axis on
          // which they are separable at all — they share the arc in the other two.
          const hoodY = Math.max(...axleVerts(named('bb-turret-hood')[0]).map((v) => Math.abs(v.y)));
          const cheekInner = Math.min(...cv.flat().map((v) => Math.abs(v.y)));
          check(
            `${tag}: ...and hood and cheek are FLUSH across the channel — one assembly, not two parts`,
            Math.abs(cheekInner - hoodY) <= F32,
            `hood side face ±${hoodY.toFixed(4)}, cheek inner face ±${cheekInner.toFixed(4)}`,
          );
          // ⚠️ AND NOTHING FIXED IS IN THE VOLUME THE CHEEK SWEEPS. The sweep is stated rather
          // than sampled: the cheek lives in the lateral band [elemR, plateGap/2 − clear], and
          // over 0…80° it covers r ≤ hoodR + BB_HOOD_T for θ ∈ [90°, 90° + cap + wrap] (plus its
          // boss at every θ). So a fixed vertex inside ALL THREE is an interpenetration, and the
          // SHAFT is the one exemption — a pivot boss and the shaft it is journalled on share an
          // axis by definition. The band is the whole reason the cheeks are inboard: outboard,
          // the belt and the flywheel pulley own everything past ±1.98.
          const bandIn = H.elemR;
          const bandOut = H.plateGap / 2 - BB_HOOD_SIDE_CLEAR;
          const sweptTo = TH_EXIT + BB_TURRET_PITCH_MAX + BB_HOOD_WRAP;
          let intruder = '';
          let nearest = Infinity;
          for (const m of meshes) {
            if (m.name === 'bb-turret-hood' || m.name === 'bb-turret-hood-cheek' || m.name === 'bb-turret-shaft') continue;
            for (const v of axleVerts(m)) {
              const ay = Math.abs(v.y);
              if (ay < bandIn - F32 || ay > bandOut + F32) continue;
              const r = Math.hypot(v.x, v.z);
              const th = Math.atan2(v.z, v.x);
              const thn = th < -1e-9 ? th + Math.PI * 2 : th;
              if (thn < TH_EXIT - F32 || thn > sweptTo + F32) continue;
              nearest = Math.min(nearest, r - (H.hoodR + BB_HOOD_T));
              if (r <= H.hoodR + BB_HOOD_T + F32) intruder = `${m.name} at r=${r.toFixed(2)} θ=${((thn * 180) / Math.PI).toFixed(0)}° |y|=${ay.toFixed(2)}`;
            }
          }
          check(
            `${tag}: ...and nothing fixed is inside the volume a cheek sweeps over 0…80°, bar the shaft it pivots on`,
            intruder === '',
            intruder || `nearest fixed part in the cheeks' lane (±${bandIn.toFixed(2)}…${bandOut.toFixed(2)}) clears the sector by ${Number.isFinite(nearest) ? nearest.toFixed(3) : 'the whole band is empty'}`,
          );
        }

        // ══ THE FLYWHEEL IS 72 mm, IT SITS ON THE TURRET PLATE, AND THERE IS ONE OF IT ═════
        // "The flywheel can be situated much lower. It just needs to be right above the turret
        // plate." — and "a standard flywheel is 72 mm diameter". Both are measurements now, and
        // the radius is checked by converting it BACK: a decimal literal that had drifted would
        // not come out at 72. It is the SAME wheel on both heads.
        //
        // ⚠️ **AND IT IS ONE WHEEL, CENTRED** (owner, 2026-09-19: "the flywheel on the shooter
        // looks like there are two wheels stacked next to each other. there should just be one in
        // the center"). It was two 0.9-in meshes at y = ±0.7. There was no seam and no groove to
        // blame — two meshes is what two wheels look like — so this counts the meshes, puts the
        // one that is left on the centreline, and holds its width off the ELEMENT rather than off
        // a literal, since a NECTAR head grips a bigger ball with a wider tyre.
        {
          pose(BB_TURRET_PITCH_MIN);
          const wheel = named('bb-turret-flywheel');
          const vs = wheel.flatMap((m) => axleVerts(m));
          const rim = Math.max(...vs.map((v) => Math.hypot(v.x, v.z)));
          const bottom = Math.min(...wheel.flatMap((m) => robotVerts(m)).map((v) => v.z));
          const ys = vs.map((v) => v.y);
          const centre = (Math.min(...ys) + Math.max(...ys)) / 2;
          const width = Math.max(...ys) - Math.min(...ys);
          check(
            `${tag}: there is exactly ONE flywheel mesh and it is centred on the channel`,
            wheel.length === 1 && Math.abs(centre) < F32,
            `${wheel.length} wheel(s), centre y ${centre.toFixed(5)} (it was two, at ±0.700)`,
          );
          check(
            `${tag}: ...its width is half an element diameter — enough tyre to grip the ball it pinches`,
            Math.abs(width - H.elemR) < F32,
            `${width.toFixed(3)} in on an element of radius ${H.elemR}`,
          );
          check(
            `${tag}: ...and the shaft shows between the tyre and each plate, rather than the gap being filled`,
            H.plateGap / 2 - width / 2 > 0.5 && width < H.plateGap - 1.0,
            `${(H.plateGap / 2 - width / 2).toFixed(3)} in of bare shaft each side of a ${width.toFixed(2)}-in wheel in a ${H.plateGap.toFixed(2)} channel`,
          );
          check(
            `${tag}: the flywheel’s drawn radius back-converts to 72 mm`,
            Math.abs(rim * 25.4 * 2 - BB_FLYWHEEL_D_MM) < 0.5,
            `${(rim * 25.4 * 2).toFixed(2)} mm (drawn as a 14-segment wheel, so the rim reads a hair under)`,
          );
          check(
            `${tag}: ...and its lowest point is BB_FLYWHEEL_CLEAR above the turret plate, not hung in the air`,
            Math.abs(bottom - (BB_TURRET_PLATE_TOP_Z + BB_FLYWHEEL_CLEAR)) < 1e-6,
            `${bottom.toFixed(3)} vs plate top ${BB_TURRET_PLATE_TOP_Z.toFixed(3)} + ${BB_FLYWHEEL_CLEAR}`,
          );
          // ...and it is JOURNALLED: everywhere the plate's flat top does not cut across it, the
          // plate is behind the wheel's rim. An earlier band left a bare annulus between its hub
          // and its rim with the rim sitting in it — owner: "the flywheel looks like it is not
          // constrained to the plate anymore".
          let gaps = 0;
          for (let i = 0; i < 720; i++) {
            const th = (Math.PI * 2 * i) / 720;
            if (Math.sin(th) * BB_FLYWHEEL_R > BB_SIDE_PLATE_TOP_Z) continue; // the flat top, where the hood is
            if (plateR(th) < BB_FLYWHEEL_R) gaps++;
          }
          check(`${tag}: ...and the plate covers the wheel’s rim everywhere its flat top does not cut it`, gaps === 0, `${gaps} of 720 sampled angles uncovered`);
          // …which needs the plate SOLID. A bore would show as drawn material stopping at some
          // radius INSIDE the profile's own smallest value; with no bore the closest the plate
          // ever comes to the axle is the profile itself, which is its flat top at θ = 90°.
          let profileMin = Infinity;
          for (let i = 0; i < 3600; i++) profileMin = Math.min(profileMin, plateR((Math.PI * 2 * i) / 3600));
          const bore = Math.min(...axleVerts(named('bb-turret-side-plate')[0]).map((v) => Math.hypot(v.x, v.z)));
          check(`${tag}: ...which needs the plate SOLID, with no bore for the rim to show through`, bore >= profileMin - F32, `closest drawn radius ${bore.toFixed(4)} vs the profile's own minimum ${profileMin.toFixed(4)}`);
        }

        // ══ NOTHING SWEEPS BELOW THE DECK, AND NOTHING THROUGH THE TURRET PLATE ════════════
        //
        // ⚠️ THE FAILURE THIS REPLACES WAS REAL AND IT WAS INVISIBLE AT REST: with the whole head
        // on the pitch node, the side plate's rear corner went 1.10 in INSIDE the drivetrain at
        // ~44° and the feed ramp swept to 0.04 in off the tile.
        //
        // The second half is new and it is the NECTAR head's: a bigger hood dips 0.26 in below the
        // turret plate at full elevation. That is allowed only because it happens inside the FEED
        // SLOT, which is a rounded rectangle and not a bore for exactly this reason — so the rule
        // is not "nothing goes below the plate" but "nothing goes below it anywhere but through
        // the hole", and it is measured per vertex.
        {
          let lowest = Infinity;
          let who = '';
          let throughPlate = 0;
          let worstThrough = '';
          for (let i = 0; i < PITCHES; i++) {
            pose(pitchAt(i));
            for (const m of meshes) {
              if (m.name === 'bb-turret-plate' || m.name === 'bb-turret-ring') continue;
              for (const v of robotVerts(m)) {
                if (v.z < lowest) {
                  lowest = v.z;
                  who = `${m.name} @${((pitchAt(i) * 180) / Math.PI).toFixed(0)}°`;
                }
                if (v.z >= BB_TURRET_PLATE_TOP_Z - F32) continue;
                const inSlot =
                  v.x >= H.slotBackX - F32 && v.x <= H.slotFrontX + F32 && Math.abs(v.y) <= H.slotHalfW + F32;
                if (!inSlot) {
                  throughPlate++;
                  worstThrough = `${m.name} (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) @${((pitchAt(i) * 180) / Math.PI).toFixed(0)}°`;
                }
              }
            }
          }
          check(`${tag}: NOTHING on the turret reaches below the deck, at any elevation`, lowest >= BB_DECK_Z - F32, `lowest ${lowest.toFixed(4)} (${who}) vs deck ${BB_DECK_Z}`);
          check(
            `${tag}: ...and whatever goes below the turret plate goes through its SLOT and nowhere else`,
            throughPlate === 0,
            worstThrough || `slot x [${H.slotBackX.toFixed(2)}, ${H.slotFrontX.toFixed(2)}] ±${H.slotHalfW.toFixed(2)}`,
          );
          // …and the things that ELEVATE keep a real margin over the drivetrain, not a rounding one
          let swept = Infinity;
          for (let i = 0; i < PITCHES; i++) {
            pose(pitchAt(i));
            for (const n of ['bb-turret-hood', 'bb-turret-hood-cheek']) {
              for (const m of named(n)) for (const v of robotVerts(m)) swept = Math.min(swept, v.z);
            }
          }
          check(`${tag}: ...and the hood and its arms clear the deck by the design’s own 0.2 in margin`, swept >= BB_DECK_Z + 0.2, `hood sweep bottoms out at ${swept.toFixed(3)}`);
        }

        // ══ THE BRACES, THE MOTOR AND THE BELT ═════════════════════════════════════════════
        //
        // Sites come from `BB_TURRET_BRACES` and `BbHeadDims.motorR`, both derived in `config.ts`.
        // ⚠️ **OWNER ITEM (a) IS THE MOTOR ONE: "the motor should be on the other side of the
        // flywheel, behind the hood."** It sat at θ = −15°, forward and under the wheel. "Behind
        // the hood" is measured here as a fact about the DRAWN meshes — the can's front face is
        // behind the rear-most point the hood reaches at ANY elevation — rather than as an angular
        // window, because the hood sweeps a whole disc over the pitch envelope.
        {
          pose(BB_TURRET_PITCH_MIN);
          const braceVs = robotVerts(named('bb-turret-brace')[0]);
          const plateOuterY = H.plateGap / 2 + BB_SHOOTER_PLATE_T;
          check(
            `${tag}: the two plates are TIED together: the braces span the channel and stand proud of both outer faces`,
            BB_TURRET_BRACES.length >= 2 && Math.max(...braceVs.map((v) => v.y)) > plateOuterY && Math.min(...braceVs.map((v) => v.y)) < -plateOuterY,
            `${BB_TURRET_BRACES.length} standoffs, y ±${Math.max(...braceVs.map((v) => v.y)).toFixed(3)} vs plate face ±${plateOuterY.toFixed(3)}`,
          );
          check(
            `${tag}: ...and every one of them stands ABOVE the turret plate it is bolted over`,
            Math.min(...braceVs.map((v) => v.z)) >= BB_TURRET_PLATE_TOP_Z - 1e-9,
            `lowest ${Math.min(...braceVs.map((v) => v.z)).toFixed(4)} vs plate top ${BB_TURRET_PLATE_TOP_Z.toFixed(3)}`,
          );
          for (const site of BB_TURRET_BRACES) {
            const deg = ((site.th * 180) / Math.PI).toFixed(0);
            const inside = plateR(site.th) - (site.r + BB_TURRET_BRACE_R);
            const rim = site.r - BB_TURRET_BRACE_R - BB_FLYWHEEL_R;
            check(`${tag}: brace @${deg}°: inside the plate profile it bolts to, and clear of the wheel it sits beside`, inside > 0 && rim >= 0.2 - 1e-9 && rim <= 1.0, `inside ${inside.toFixed(3)}, off the rim ${rim.toFixed(3)}`);
          }
          const mv = robotVerts(named('bb-turret-motor')[0]);
          check(
            `${tag}: the flywheel motor's can is BETWEEN the plates, not outboard of one`,
            Math.max(...mv.map((v) => Math.abs(v.y))) <= H.plateGap / 2 + F32,
            `±${Math.max(...mv.map((v) => Math.abs(v.y))).toFixed(2)} in a ±${(H.plateGap / 2).toFixed(2)} channel`,
          );
          let hoodBack = Infinity;
          for (let i = 0; i < PITCHES; i++) {
            pose(pitchAt(i));
            for (const n of ['bb-turret-hood', 'bb-turret-hood-cheek']) {
              for (const m of named(n)) for (const v of robotVerts(m)) hoodBack = Math.min(hoodBack, v.x);
            }
          }
          pose(BB_TURRET_PITCH_MIN);
          const motorFront = Math.max(...mv.map((v) => v.x));
          check(
            `${tag}: ...and it is BEHIND THE HOOD (owner item a) — its whole can is past the hood's rear-most sweep`,
            motorFront < hoodBack - 0.2 && motorFront < 0,
            `can front ${motorFront.toFixed(3)} vs hood rear-most over the sweep ${hoodBack.toFixed(3)}`,
          );
          check(
            `${tag}: ...standing clear behind the feed wall rather than floating, and over the turret plate`,
            Math.min(...mv.map((v) => v.z)) >= BB_TURRET_PLATE_TOP_Z - F32 &&
              Math.abs(motorFront - (H.axleX - H.wallR - BB_FEED_WALL_T - 0.05)) < F32,
            `can front ${motorFront.toFixed(3)} vs wall rear face ${(H.axleX - H.wallR - BB_FEED_WALL_T).toFixed(3)}, bottom ${Math.min(...mv.map((v) => v.z)).toFixed(3)}`,
          );
          // ⚠️ **AND IT BOLTS TO A SIDE PLATE** (owner, 2026-09-21). The can's axis is lateral, so
          // its mounting FACE is a y = const plane; the ears it used to bolt to were a slab in the
          // side plate's own plane with a 0.63-in gap to the plate itself. Its face is ON the
          // plate now — the drive side's inner face, the same plate the belt runs down and the
          // flywheel is journalled in — and the plate's rear flat leaves one `BB_MOTOR_MOUNT_RIM`
          // of material all the way round the can (measured: 0.150 everywhere, both heads).
          {
            const faceY = Math.max(...mv.map((v) => v.y));
            const plateInner = H.plateGap / 2;
            let rim = Infinity;
            for (let i = 0; i < 720; i++) {
              const a = (Math.PI * 2 * i) / 720;
              const px = -H.motorR + Math.cos(a) * BB_TURRET_MOTOR_R;
              const pz = Math.sin(a) * BB_TURRET_MOTOR_R;
              // the three plate edges the can comes near: the undercut under it, the rear flat
              // behind it, the top flat over it
              rim = Math.min(rim, UNDER.nx * px + UNDER.nz * pz - UNDER.c, px - H.sideRearX, BB_SIDE_PLATE_TOP_Z - pz);
            }
            check(
              `${tag}: ...and its mounting FACE is ON the drive-side plate, inside a rim of plate all round the can`,
              Math.abs(faceY - plateInner) <= 1e-3 && Math.abs(rim - BB_MOTOR_MOUNT_RIM) < 1e-6,
              `face y ${faceY.toFixed(4)} vs the plate's inner face ${plateInner.toFixed(4)}; worst rim ${rim.toFixed(4)} vs ${BB_MOTOR_MOUNT_RIM}`,
            );
          }
          const bv = robotVerts(named('bb-turret-belt')[0]);
          check(
            `${tag}: the drive is a BELT, and it runs OUTBOARD of a side plate — the hood's shell crosses every line inside`,
            Math.min(...bv.map((v) => Math.abs(v.y))) >= H.plateGap / 2 + BB_SHOOTER_PLATE_T &&
              Math.min(...bv.map((v) => Math.abs(v.y))) > H.plateGap / 2 + BB_SHOOTER_PLATE_T + BB_BRACE_PROUD - 0.06,
            `belt inner face ${Math.min(...bv.map((v) => Math.abs(v.y))).toFixed(3)} vs plate face ${(H.plateGap / 2 + BB_SHOOTER_PLATE_T).toFixed(3)} and brace ends ${(H.plateGap / 2 + BB_SHOOTER_PLATE_T + BB_BRACE_PROUD).toFixed(3)}`,
          );
          check(
            `${tag}: ...and it reaches BOTH pulleys, so it is a drive and not a decal`,
            Math.abs(Math.min(...bv.map((v) => v.x)) - (H.axleX - H.motorR - 0.54)) < 0.1 &&
              Math.max(...bv.map((v) => v.x)) > H.axleX + 0.6,
            `belt x [${Math.min(...bv.map((v) => v.x)).toFixed(2)}, ${Math.max(...bv.map((v) => v.x)).toFixed(2)}]`,
          );
        }

        // ══ (c) THE FEED THROAT IS FIXED, AND IT IS THE REAR TIE ═══════════════════════════
        //
        // "There is still a weird flap in the back of the shooter that does nothing." — reported
        // TWICE, the second time against the FEED SHOE a previous pass had put there. What stands
        // there now is the back of the channel the element rises through: a flat vertical wall on
        // the turret plate, one hood-sweep radius plus a slide behind the rising element, spanning
        // the whole channel and both plates. Its invariance under pitch is proved by the block
        // above; what is proved here is that it is the tie, that it stands on the plate, and that
        // the hood clears it at every elevation.
        {
          pose(BB_TURRET_PITCH_MIN);
          const throat = named('bb-turret-throat')[0];
          const tv = robotVerts(throat);
          // ⚠️ IT REACHES EACH PLATE'S INNER FACE AND NO FURTHER (owner, 2026-09-21: the side plate
          // must read as ONE piece). This used to require the wall to pass THROUGH both plates and
          // stand proud of their outer faces — which drew a vertical rib across each plate, exactly
          // where the old motor ear began, so a one-piece plate still looked split.
          const plateInnerY = H.plateGap / 2;
          const wallMaxY = Math.max(...tv.map((v) => v.y));
          const wallMinY = Math.min(...tv.map((v) => v.y));
          check(
            `${tag}: the FEED THROAT ties both plates — it spans the channel to each plate's INNER face, and never shows through one`,
            Math.abs(wallMaxY - plateInnerY) < F32 && Math.abs(wallMinY + plateInnerY) < F32,
            `y ${wallMinY.toFixed(3)}…${wallMaxY.toFixed(3)} vs inner faces ±${plateInnerY.toFixed(3)}`,
          );
          check(
            `${tag}: ...and its top sits below the plates' top edge (no line along the top of a plate)`,
            Math.max(...tv.map((v) => v.z)) < BB_TURRET_AXLE_Z + BB_SIDE_PLATE_TOP_Z - 1e-3,
            `wall top ${Math.max(...tv.map((v) => v.z)).toFixed(3)} vs plate top ${(BB_TURRET_AXLE_Z + BB_SIDE_PLATE_TOP_Z).toFixed(3)}`,
          );
          check(
            `${tag}: ...and it STANDS ON the turret plate, at the back of the rising element`,
            Math.abs(Math.min(...tv.map((v) => v.z)) - BB_TURRET_PLATE_TOP_Z) < F32 &&
              Math.max(...tv.map((v) => v.x)) < -H.elemR,
            `bottom ${Math.min(...tv.map((v) => v.z)).toFixed(3)} on a plate at ${BB_TURRET_PLATE_TOP_Z}, front face ${Math.max(...tv.map((v) => v.x)).toFixed(3)} behind an element of radius ${H.elemR}`,
          );
          // the hood sweeps a DISC about the axle, so a vertical plane outside that radius clears
          // it at EVERY elevation — measured rather than reasoned about
          let hoodBack = Infinity;
          for (let i = 0; i < PITCHES; i++) {
            pose(pitchAt(i));
            for (const n of ['bb-turret-hood', 'bb-turret-hood-cheek']) {
              for (const m of named(n)) for (const v of robotVerts(m)) hoodBack = Math.min(hoodBack, v.x);
            }
          }
          pose(BB_TURRET_PITCH_MIN);
          check(
            `${tag}: ...and the hood sweeps INSIDE it, so the two never touch at any elevation`,
            Math.max(...tv.map((v) => v.x)) <= hoodBack - 0.05,
            `wall front ${Math.max(...tv.map((v) => v.x)).toFixed(3)}, hood rear-most ${hoodBack.toFixed(3)} — ${(hoodBack - Math.max(...tv.map((v) => v.x))).toFixed(3)} of slide`,
          );
          check(
            `${tag}: ...and the hood’s wrap is the SHORT one a fixed entry made possible`,
            BB_HOOD_WRAP < 0.6,
            `${((BB_HOOD_WRAP * 180) / Math.PI).toFixed(1)}° (was 60°, and a 60° hood’s mouth is 80° out of line at full elevation)`,
          );
        }

        // ══ WHERE THE CHEEKS LIVE ══════════════════════════════════════════════════════════
        //
        // The lateral strip between the element and the side plate is the only place they CAN be:
        // in the x–z PROJECTION the element fills every path from the axle to the hood, and an
        // element is a sphere, so at lateral offset `elemR` it has no cross-section left to foul.
        // It is also where the clearance is — outboard, the belt and the flywheel pulley own
        // everything past ±1.98 on the drive side.
        {
          pose(BB_TURRET_PITCH_MIN);
          const ys = named('bb-turret-hood-cheek').flatMap((m) => axleVerts(m)).map((v) => Math.abs(v.y));
          check(
            `${tag}: a cheek is inboard of the side plate by BB_HOOD_SIDE_CLEAR, and never inside the element’s own width`,
            Math.min(...ys) >= H.elemR - F32 && Math.abs(Math.max(...ys) - (H.plateGap / 2 - BB_HOOD_SIDE_CLEAR)) < F32,
            `|y| ${Math.min(...ys).toFixed(3)} … ${Math.max(...ys).toFixed(3)}; element ±${H.elemR}, plate face ${(H.plateGap / 2).toFixed(3)}`,
          );
          check(
            `${tag}: ...so they do not read as a third plate: both are inside the plates they hide between`,
            Math.max(...ys) < H.plateGap / 2,
            `${Math.max(...ys).toFixed(3)} vs ${(H.plateGap / 2).toFixed(3)}`,
          );
          const fwY = Math.max(...named('bb-turret-flywheel').flatMap((m) => axleVerts(m)).map((v) => Math.abs(v.y)));
          check(
            `${tag}: ...and they clear the flywheel they straddle`,
            Math.min(...ys) - fwY > 0.1,
            `${(Math.min(...ys) - fwY).toFixed(3)} in`,
          );
        }

        // ══ THE EXIT CORRIDOR IS UNOBSTRUCTED, AT EVERY ELEVATION ══════════════════════════
        //
        // The element leaves the lip along the hood's own tangent and flies an element-wide tube
        // out of the machine. Every member that SPANS THE CHANNEL has to stay out of it.
        //
        // ⚠️ MEASURED ON THE DRAWN MESHES, projected into the axle plane. A part whose lateral
        // extent never reaches the element (the side plates, the hood arms, the belt) cannot
        // obstruct it at all and is excluded by that test rather than by a list; the hood and the
        // wheel ARE the mechanism that throws it, so they are excluded too. `CHORD` is the sagitta
        // a 10-segment standoff loses to its own faceting — this is a clearance measurement, so it
        // is paid.
        {
          const CHORD = 0.02;
          const EXCLUDE = ['bb-turret-hood', 'bb-turret-hood-cheek', 'bb-turret-flywheel', 'bb-turret-side-plate'];
          let worst = Infinity;
          let who = '';
          for (let i = 0; i < PITCHES; i++) {
            const p = pitchAt(i);
            pose(p);
            const m = bbMuzzleLocal(p, which);
            const ox = -m.back - H.axleX; // the lip, in the AXLE frame
            const oz = m.z - BB_TURRET_AXLE_Z;
            const dx = Math.cos(p);
            const dz = Math.sin(p);
            for (const mesh of meshes) {
              if (EXCLUDE.includes(mesh.name)) continue;
              const vs = axleVerts(mesh);
              // ⚠️ THE LATERAL TEST IS ON THE PART'S y INTERVAL, NOT ON ITS NEAREST VERTEX. A
              // `CylinderGeometry` standoff has vertices at its two END CAPS and nowhere in
              // between, so "nearest vertex to the centreline" reads ±1.92 for a member that runs
              // straight through y = 0 — and the braces, the motor and the belt all dropped out of
              // this sweep unmeasured. The interval is what spans the channel.
              const ys = vs.map((v) => v.y);
              if (Math.min(...ys) >= H.elemR - F32 || Math.max(...ys) <= -H.elemR + F32) continue;
              for (const v of vs) {
                const s = (v.x - ox) * dx + (v.z - oz) * dz;
                if (s < 0 || s > 8) continue;
                const perp = Math.abs((v.x - ox) * dz - (v.z - oz) * dx) - H.elemR - CHORD;
                if (perp < worst) {
                  worst = perp;
                  who = `${mesh.name || 'slew ring'} @${((p * 180) / Math.PI).toFixed(0)}°`;
                }
              }
            }
          }
          check(`${tag}: the EXIT CORRIDOR is unobstructed at every elevation`, worst > 0, `worst clearance ${worst.toFixed(3)} in (${who})`);
          // A RATCHET. The +20° brace leaves 0.164 and it stays: the side plate's own flat top is
          // the binding part at that height and clears the corridor by 0.150 BY DEFINITION
          // (`BB_SIDE_PLATE_TOP_Z` is one element radius plus 0.15 under the corridor's centre
          // line), so nothing fixed up there can do better. What must not happen is the margin
          // shrinking, and this is what says so.
          check(
            `${tag}: ...with the margin the design measured, not less`,
            worst >= 0.15,
            `${worst.toFixed(3)} after the ${CHORD} chord pad — the binding part is the +20° brace at 0.164`,
          );
          check(
            `${tag}: ...and the plate’s flat top is the ceiling anything fixed can reach`,
            Math.abs(H.pathR - H.elemR - BB_SIDE_PLATE_TOP_Z - 0.15) < 1e-9,
            `${(H.pathR - H.elemR - BB_SIDE_PLATE_TOP_Z).toFixed(3)} in under the corridor floor`,
          );
        }
        disposeRobotGroup(turret);
      }

      // ══ THE CHAIN IS NOT DUPLICATED IN THE RENDERER ═════════════════════════════════════
      //
      // ⚠️ THE ORIGINAL SIN, ASSERTED GONE. The renderer owned `BB_FLYWHEEL_R`, `BB_HOOD_R`,
      // `BB_HOOD_PATH_R`, `BB_HOOD_WRAP` and the plate profile as local `const`s and the sim owned
      // `BB_LAUNCH_Z0`; six passes of feedback each moved one of them. A second copy of any of
      // them is the bug, so it is named.
      {
        const dupes = ['BB_FLYWHEEL_R', 'BB_HOOD_R', 'BB_HOOD_PATH_R', 'BB_HOOD_COMPRESSION', 'BB_HOOD_WRAP', 'BB_HOOD_T', 'BB_TURRET_AXLE_Z', 'BB_DECK_Z', 'BB_TURRET_BRACE_R', 'BB_SHOOTER_PLATE_T', 'BB_BRACE_PROUD']
          .filter((n) => new RegExp(`^const ${n}\\b`, 'm').test(robotsCode));
        check('renderRobots.ts declares NO second copy of a shooter dimension', dupes.length === 0, dupes.join(', '));
        check(
          '...and the retired pieces of the muzzle-pivot and feed-shoe eras are gone with them',
          !/BB_HEAD_RHO_MAX|minHeadWorldZ|plateOuterR|BB_PLATE_R_OUT|BB_PLATE_TAIL|BB_SHOOTER_MUZZLE_Z|BB_FEED_SHOE|BB_FEED_TILT/.test(robotsCode),
        );
        check(
          'the muzzle node is placed by the SIM’s own function, imported, not by a local formula',
          robotsCode.includes('bbMuzzleLocal') &&
            robotsCode.includes('const rest = bbMuzzleLocal(BB_TURRET_PITCH_MIN, which);') &&
            robotsCode.includes('exit.position.set(-rest.back - H.axleX, 0, rest.z - BB_TURRET_AXLE_Z);'),
          'the lip is read off bbMuzzleLocal at rest; the node’s own rotation carries it to every other pitch',
        );
        check(
          'the node names are still the interface the sync writes to',
          robotsCode.includes("head.name = 'bb-turret-head'") &&
            robotsCode.includes("pitch.name = 'bb-turret-pitch'") &&
            robotsCode.includes("exit.name = 'bb-turret-exit'") &&
            robotsCode.includes('pitches[0].rotation.y = -(r.bbTurretPitch ?? 0);') &&
            robotsCode.includes('heads[0].rotation.z = r.turretHeading - r.heading;'),
        );
        check(
          '...and the YAW node is on the ROTATION AXIS with the axle offset INSIDE it, which is what lets the axle orbit',
          robotsCode.includes("axle.position.set(H.axleX, 0, BB_TURRET_AXLE_Z - BB_DECK_Z);") &&
            !/head\.position\.z = BB_TURRET_AXLE_Z/.test(robotsCode) &&
            !/head\.position\.z = BB_LAUNCH_Z0/.test(robotsCode),
        );
        check(
          'a DOUBLE turret builds its NECTAR head as turret 1, so the picture and bbMuzzleLocal pick the same one',
          // the WHICH argument is the seam this pins. There USED to be a trailing `accent` here;
          // the flywheel stopped taking the cosmetic on 2026-09-21 and the parameter went with it.
          robotsCode.includes('buildTurret(spec, launcher.mount, 0)') &&
            robotsCode.includes('buildTurret(spec, launcher.mount2, 1)'),
        );
      }
      // ── 2026-09-19 OWNER PLAYTEST: "SWERVE IS NOT RENDERED PROPERLY AT ALL" ───────────────
      // It was one squat cylinder per corner floating at deck height with the wheel left behind
      // pointing forward — a puck, not a module, and unable to steer. A pod is a group whose
      // ORIGIN is the contact patch (the steering axis), carrying the wheel, a twin-plate fork,
      // a kingpin and a toothed slew ring.
      //
      // ⚠️ AND NOTHING ABOVE THE RING (owner follow-up, same day: "the motor for swerve does NOT
      // go on top of the swerve module"). The first pass stood a motor can on the slew ring. A
      // swerve steering motor lives on the DECK and drives the ring through the belt or gear the
      // ring is toothed for; the ring is already what says the pod is driven.
      {
        check(
          'a swerve pod is a real assembly: fork + kingpin, slew ring, belt drive',
          robotsCode.includes("framePart('swervePod:struct'") &&
            robotsCode.includes("framePart('swervePod:ring'") &&
            robotsCode.includes("framePart('swervePod:drive'") &&
            /TWIN FORK PLATES/.test(robotsSrc) &&
            /THE KINGPIN/.test(robotsSrc) &&
            /THE BELT DRIVE/.test(robotsSrc),
        );
        check(
          '...and NOTHING is stood on top of it',
          !robotsCode.includes("framePart('swervePod:motor'") && !/BB_POD_MOTOR_/.test(robotsCode),
        );
        check(
          '...and the floating deck-height puck is gone',
          !/BB_DECK_Z \+ 1\.1/.test(robotsCode) && !/CylinderGeometry\(1\.1, 1\.1, 2\.2, 10\)/.test(robotsCode),
        );
        // THE POD TURNS ABOUT THE CONTACT PATCH. The group sits at (x, y, 0) and the wheel is at
        // the group's own origin lifted by its radius, so `rotation.z` is a zero-scrub-radius
        // steer — put the pivot anywhere else and the wheel sweeps a circle on the floor.
        check(
          'the pod pivots about the wheel’s contact patch',
          robotsCode.includes('pod.position.set((Math.sign(x) || 1) * (hl - BB_POD_INSET), sy * (hw - BB_POD_INSET), 0);') &&
            robotsCode.includes('wheel.position.set(0, 0, BB_POD_WHEEL_R);'),
        );
        // ══ (2) THE WHEEL READS AS A WHEEL — BUILT AND MEASURED, NOT GREPPED ═══════════════
        //
        // ⚠️ **OWNER, 2026-09-19: "the swerve wheel has two rectangular plates blocking the wheel,
        // so it looks like it is just a rectangular cylinder as the wheel. Fix this. Remove those
        // plates or make it smaller."** The fork was a 3.2 × 3.5 rectangle either side of a 3.0-in
        // wheel, from z 0.40 up to the top plate — in side view it covered the tyre completely,
        // end to end and top to bottom, so all that was left of the wheel was a dark band under
        // the plate's lower edge.
        //
        // The rule that answers it is a SILHOUETTE rule, so it is measured on the built pod: at
        // the fork's own lateral plane, what fraction of the wheel's circle does the fork cover?
        // The fork is shorter than the wheel and stops at a boss around the axle, so the tyre's
        // whole lower half and both ends of its circle are in plain sight.
        //
        // ⚠️ A BOUNDING BOX OVER THE WHOLE STRUCT MESH MEASURES THE WRONG THING, AND DID. `podParts()`
        // merges the two fork plates, the TOP PLATE (`BB_POD_L` = 3.2 long, sitting at
        // `BB_POD_PLATE_Z` − 0.3 to `BB_POD_PLATE_Z`, i.e. z 3.60–3.90 — entirely ABOVE the wheel's
        // own crown at z 3.00) and the kingpin into one unnamed geometry, so a box around all of it
        // reported the TOP PLATE's own length as "the fork" and multiplied it by the full height down
        // to the boss, when the top plate stands over the tyre and obstructs nothing. So this instead
        // walks the struct mesh's own WORLD-SPACE TRIANGLES, keeps only the ones that reach the
        // wheel's crown or below it (the only geometry that can stand in front of the tyre at all),
        // and RASTERISES that subset onto the wheel's own x-z plane to measure the silhouette
        // directly — a fixed grid and a deterministic point-in-triangle test, no randomness.
        {
          const pod = buildSwervePod();
          pod.updateMatrixWorld(true);
          const podMeshes: THREE.Mesh[] = [];
          pod.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) podMeshes.push(o as THREE.Mesh);
          });
          const box = (o: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(o);
          // ⚠️ `bb-pod-wheel` IS A GROUP (the real 72 mm Hogback: tread band + core), so it is
          // looked up over every object rather than over the meshes — `setFromObject` takes
          // either. The MEASUREMENT is unchanged: this is still the tyre's own world-space box.
          const wheelBox = box(pod.getObjectByName('bb-pod-wheel') as THREE.Object3D);
          const hubBox = box(podMeshes.find((m) => m.name === 'bb-pod-hub') as THREE.Mesh);
          // `podParts()` pushes struct, then ring, then drive, in that order, and only the struct
          // reaches anywhere near the wheel (the ring sits up at the top plate and the drive's
          // pulleys sit outboard of the fork) — none of the three carries a `.name`, so the first
          // of them in traversal order is the struct. ⚠️ EVERY MESH THE WHEEL ITSELF ADDS IS
          // NAMED (`bb-wheel-tread` / `bb-wheel-core`) precisely so this stays true.
          const structMesh = podMeshes.filter((m) => !m.name)[0];
          const wheelR = (wheelBox.max.z - wheelBox.min.z) / 2;
          const crownZ = wheelBox.max.z;
          // the struct's geometry is guaranteed non-indexed (`framePart` flattens every input
          // first — see its own comment), so every run of 3 position entries is one triangle
          const pos = structMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
          const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
          for (let i = 0; i + 2 < pos.count; i += 3) {
            const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(structMesh.matrixWorld);
            const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(structMesh.matrixWorld);
            const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2).applyMatrix4(structMesh.matrixWorld);
            // keep a triangle if any corner reaches the crown or below it — a straddling triangle
            // still occupies some of the space in front of the tyre
            if (a.z <= crownZ || b.z <= crownZ || c.z <= crownZ) tris.push([a, b, c]);
          }
          const belowVerts = tris.flat().filter((v) => v.z <= crownZ);
          const forkMinX = Math.min(...belowVerts.map((v) => v.x));
          const forkMaxX = Math.max(...belowVerts.map((v) => v.x));
          const forkMinZ = Math.min(...belowVerts.map((v) => v.z));
          const forkLen = forkMaxX - forkMinX;
          check(
            'a swerve POD WHEEL is a wheel: the fork is shorter than the tyre and stops at a boss, not a shroud',
            forkLen < wheelBox.max.x - wheelBox.min.x - 0.6 && forkMinZ > wheelR * 0.6,
            `fork ${forkLen.toFixed(2)} long over a ${(wheelBox.max.x - wheelBox.min.x).toFixed(2)} tyre, bottom ${forkMinZ.toFixed(2)} vs an axle at ${wheelR.toFixed(2)}`,
          );
          // project the below-crown triangles onto the x-z plane and sample a fixed grid over the
          // wheel's own bounding square; a per-triangle bounding box skips most of the point-in-
          // triangle tests, but changes no result, since it is only ever a cheap reject before it.
          const sameSide = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number =>
            (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
          const inTri = (px: number, pz: number, t: [THREE.Vector3, THREE.Vector3, THREE.Vector3]): boolean => {
            const [a, b, c] = t;
            const d1 = sameSide(px, pz, a.x, a.z, b.x, b.z);
            const d2 = sameSide(px, pz, b.x, b.z, c.x, c.z);
            const d3 = sameSide(px, pz, c.x, c.z, a.x, a.z);
            const neg = d1 < 0 || d2 < 0 || d3 < 0;
            const pos2 = d1 > 0 || d2 > 0 || d3 > 0;
            return !(neg && pos2);
          };
          const candidates = tris.map((t) => ({
            t,
            minX: Math.min(t[0].x, t[1].x, t[2].x),
            maxX: Math.max(t[0].x, t[1].x, t[2].x),
            minZ: Math.min(t[0].z, t[1].z, t[2].z),
            maxZ: Math.max(t[0].z, t[1].z, t[2].z),
          }));
          const GRID = 200;
          let coveredCells = 0;
          for (let gx = 0; gx < GRID; gx++) {
            const px = wheelBox.min.x + ((wheelBox.max.x - wheelBox.min.x) * (gx + 0.5)) / GRID;
            for (let gz = 0; gz < GRID; gz++) {
              const pz = wheelBox.min.z + ((wheelBox.max.z - wheelBox.min.z) * (gz + 0.5)) / GRID;
              if (
                candidates.some(
                  (c) => px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ && inTri(px, pz, c.t),
                )
              )
                coveredCells++;
            }
          }
          const clearFraction = 1 - coveredCells / (GRID * GRID);
          check(
            '...so most of the tyre’s own circle is unobstructed — it was 0% of it before',
            clearFraction > 0.55,
            `${(clearFraction * 100).toFixed(0)}% of the tyre’s square left clear`,
          );
          check(
            '...and the HUB shows through the gap the boss leaves, so it reads as a hub and not a disc',
            hubBox.max.x - hubBox.min.x > 1.2 && hubBox.max.x - hubBox.min.x < wheelR * 2 - 0.6 && hubBox.max.y > wheelBox.max.y,
            `hub ${(hubBox.max.x - hubBox.min.x).toFixed(2)} across, ${(hubBox.max.y - wheelBox.max.y).toFixed(3)} proud of each tyre face`,
          );
          // ⚠️ MEASURED, NOT GREPPED (2026-09-21). This used to pin the one source line that built
          // the pod's tyre, which was the only way to say "not the mecanum material" while the
          // difference between the two wheels was a TEXTURE. The wheels are geometry now, so the
          // claim can be made against the object: a traction wheel has NO roller mesh, and the
          // part the pod carries is the one `wheelKindOf` says a swerve carries.
          check(
            '...and the pod’s wheel is plain TRACTION — it has a tread band and no rollers at all',
            !!pod.getObjectByName('bb-wheel-tread') && !pod.getObjectByName('bb-wheel-rollers'),
          );
          check(
            '...at the size `wheelKindOf` names for a swerve, which is goBILDA’s 72 mm Hogback',
            wheelKindOf('swerve') === 'podTraction' &&
              Math.abs(BB_WHEEL_PARTS.podTraction.r * 2 * 25.4 - 72) < 1e-9,
            `${(BB_WHEEL_PARTS.podTraction.r * 2 * 25.4).toFixed(2)} mm`,
          );
          disposeRobotGroup(pod);
        }
        // ⚠️ THE STEER COMES OUT OF THE SIM, AND NOTHING WAS ADDED TO THE SIM TO FEED IT.
        // `RobotState.moduleAngles` is a REQUIRED field that has existed since the shared
        // drivetrain landed — the 2D map has always read it — and the 3D view was simply
        // ignoring it. Same for `butterflyTank`. If either ever stops being declared there, the
        // picture is being fed by a field invented for it, and this fails.
        const typesSrc = readFileSync(join(root, 'src', 'types.ts'), 'utf8');
        check(
          'the pod steers off the sim’s own moduleAngles (a pre-existing, required field)',
          /^\s*moduleAngles: number\[\];$/m.test(typesSrc) &&
            robotsCode.includes('pods[i].rotation.z = r.moduleAngles[i] ?? 0'),
        );
        check(
          '...in the SAME corner order the 2D map reads it in — [FL, FR, BL, BR]',
          /FL, FR, BL, BR/.test(robotsSrc) && /moduleAngles/.test(typesSrc),
        );
        // ══ THE POD FITS UNDER THE DECK, AND INSIDE THE FRAME AT EVERY STEER ANGLE ═══════════
        //
        // ⚠️ THE CHECK THAT WAS HERE MEASURED THE WRONG CEILING. It computed a pod top of 5.81
        // and asserted it was under `BB3_HEIGHT_MIN` (12), which it comfortably was — while the
        // slew ring stood 1.13 in ABOVE the 4.6-in deck, through the structure the pod hangs
        // from. The ceiling for a pod is the DECK PLATE'S UNDERSIDE, not the robot's legal
        // height, and the FOOTPRINT was never checked at all.
        const num = (name: string): number => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(robotsSrc)?.[1] ?? NaN);
        const deck = BB_DECK_Z;
        const ringH = num('BB_POD_RING_H');
        const podPlateZ = deck - 0.26 - ringH;
        const podTop = podPlateZ + ringH;
        check(
          'the pod top plate is derived from the deck plate, not typed',
          /const BB_POD_PLATE_Z = BB_DECK_Z - 0\.26 - BB_POD_RING_H;/.test(robotsCode),
          `${podPlateZ.toFixed(2)}`,
        );
        check(
          'THE WHOLE POD LIVES UNDER THE DECK PLATE (it used to stand 1.13 in through it)',
          Number.isFinite(podTop) && podTop <= deck - 0.26 + 1e-9,
          `${podTop.toFixed(2)} in vs the deck's underside ${(deck - 0.26).toFixed(2)}`,
        );
        // ⚠️ READ OFF THE PART TABLE, NOT OFF THE SOURCE TEXT. Since 2026-09-21 the pod's wheel IS
        // a catalogue part (`BB_WHEEL_PARTS.podTraction`, goBILDA's 72 mm Hogback) and
        // `BB_POD_WHEEL_R` is derived from it, so the `const NAME = <literal>;` scrape this block
        // uses everywhere else returns `NaN` for it. The table is exported for exactly this.
        const podWheelR = BB_WHEEL_PARTS.podTraction.r;
        check(
          '...which is only possible on a 3-in pod wheel — a 4-in one does not fit under 4.6 in',
          podWheelR * 2 + 0.3 + ringH <= deck - 0.26 + 1e-9,
          `wheel ${(podWheelR * 2).toFixed(2)} + plate + ring vs ${(deck - 0.26).toFixed(2)}`,
        );

        // THE FOOTPRINT. A pod SLEWS, so a box `L × W` rotated about its own centre has a
        // worst-case half-extent of `hypot(L, W) / 2` on either axis — that, or the slew ring's
        // flange, is the inset. Measured before this rule: +0.46 in outside the frame at rest
        // (the ring) and +0.88 at 45° of steer (the fork box), on every chassis size, because
        // the old inset was the constant wheel-channel offset.
        // the fork straddles the POD's OWN wheel now, not the mecanum channel's 48 mm — see
        // `BB_POD_WHEEL_W`, which is the line this re-derivation follows
        const podWheelW = BB_WHEEL_PARTS.podTraction.w;
        const forkT = num('BB_POD_FORK_T');
        const podDriveT = num('BB_POD_DRIVE_T');
        const podL = num('BB_POD_L');
        const podW = (podWheelW / 2 + 0.2 + forkT / 2 + podDriveT) * 2;
        const ringR = num('BB_POD_RING_R');
        const flange = num('BB_POD_RING_FLANGE');
        const inset = Math.max(Math.hypot(podL, podW) / 2, ringR + flange);
        check(
          'BB_POD_INSET is the slewing box’s own half-diagonal, re-derived here',
          /const BB_POD_INSET = Math\.max\(Math\.hypot\(BB_POD_L, BB_POD_W\) \/ 2, BB_POD_RING_R \+ BB_POD_RING_FLANGE\);/.test(robotsCode) &&
            Number.isFinite(inset),
          `${inset.toFixed(3)} in`,
        );
        for (const [L, W] of [
          [12, 12],
          [14.5, 16.5],
          [18, 18],
        ] as const) {
          const hl = L / 2;
          const hw = W / 2;
          // NOTHING the pod carries — a slewing corner, the ring's flange or the wheel itself —
          // may reach further from the pod's centre than the inset, so a pod centred at
          // `(hl − inset, hw − inset)` touches each frame face and never crosses it.
          const worst = Math.max(Math.hypot(podL, podW) / 2, ringR + flange, podWheelR);
          check(
            `swerve ${L}x${W}: every pod corner stays inside the frame at every steer angle`,
            hl - inset > 0 && hw - inset > 0 && worst <= inset + 1e-9,
            `centre ±${(hl - inset).toFixed(2)},±${(hw - inset).toFixed(2)}, worst reach ${worst.toFixed(3)} vs inset ${inset.toFixed(3)}`,
          );
          // ...and the four pods cannot overlap each other, even on the smallest legal chassis
          check(
            `swerve ${L}x${W}: the four pods clear each other`,
            2 * (hw - inset) > Math.hypot(podL, podW) && 2 * (hl - inset) > Math.hypot(podL, podW),
            `${(2 * Math.min(hl, hw) - 2 * inset).toFixed(2)} apart vs ${Math.hypot(podL, podW).toFixed(2)}`,
          );
        }
        // ...and the frame must stop drawing a channel the pod would be built through
        check(
          'buildFrame drops the inner side plate for swerve (a pod at the new inset runs through it)',
          robotsCode.includes("const dropInner = spec.drivetrain === 'swerve' || spec.drivetrain === 'xdrive';") &&
            robotsCode.includes('const plateYs = dropInner ? [outerY] : [outerY, innerY];') &&
            robotsCode.includes('for (const y of plateYs) {'),
        );

        // ══ AN X-DRIVE OMNI STAYS INSIDE THE FRAME TOO ══════════════════════════════════════
        // Owner, 2026-09-19: "selecting x drive makes the wheels stick out of the robot". A wheel
        // `2R × W` canted 45° reaches `(2R + W) / (2√2)` along BOTH axes; in the mecanum channel
        // (centre-line `plate + gap/2` = 1.17 in inside the frame) that stood 0.78 in proud of the
        // side plate on every chassis. The inset is the canted reach plus what it has to clear:
        // the side plate laterally, the cross member fore-and-aft.
        // ⚠️ THE OMNI'S OWN R AND W (2026-09-21). This used to re-derive the reach from
        // `BB_WHEEL_R`/`BB_WHEEL_W` — the mecanum — for a drivetrain that has never carried a
        // mecanum. It is goBILDA's 96 mm omni, which is both smaller in the radius and a third of
        // the width, so the reach falls 1.945 → 1.650 and every clearance below gets better.
        const omni = BB_WHEEL_PARTS.omni;
        const reach = (2 * omni.r + omni.w) / (2 * Math.SQRT2);
        const insetX = reach + num('BB_RAIL_T') + 0.15;
        const insetY = reach + num('BB_PLATE_T') + 0.15;
        check(
          'the X-drive insets are the canted OMNI’s own reach, re-derived here',
          robotsCode.includes('const BB_XDRIVE_REACH = (2 * BB_OMNI.r + BB_OMNI.w) / (2 * Math.SQRT2);') &&
            robotsCode.includes('export const BB_XDRIVE_INSET_X = BB_XDRIVE_REACH + BB_RAIL_T + BB_XDRIVE_CLEAR;') &&
            robotsCode.includes('export const BB_XDRIVE_INSET_Y = BB_XDRIVE_REACH + BB_PLATE_T + BB_XDRIVE_CLEAR;') &&
            /const BB_XDRIVE_CLEAR = 0\.15;/.test(robotsCode),
          `reach ${reach.toFixed(3)}, inset x ${insetX.toFixed(3)} / y ${insetY.toFixed(3)}`,
        );
        check(
          '...and they are the numbers the module actually exports',
          Math.abs(BB_XDRIVE_INSET_X - insetX) < 1e-9 && Math.abs(BB_XDRIVE_INSET_Y - insetY) < 1e-9,
          `${BB_XDRIVE_INSET_X.toFixed(3)} / ${BB_XDRIVE_INSET_Y.toFixed(3)}`,
        );
        check(
          '...and buildWheels places an X-drive wheel by them, not in the mecanum channel',
          robotsCode.includes('Math.max(0.5, hl - BB_XDRIVE_INSET_X)') && robotsCode.includes('Math.max(0.5, hw - BB_XDRIVE_INSET_Y)'),
        );
        for (const [L, W] of [
          [12, 12],
          [14.5, 16.5],
          [18, 18],
        ] as const) {
          const cx = L / 2 - insetX;
          const cy = W / 2 - insetY;
          check(
            `xdrive ${L}x${W}: every wheel clears the side plate and the cross member, inside the frame`,
            cx > 0.5 && cy > 0.5 && cx + reach <= L / 2 - num('BB_RAIL_T') && cy + reach <= W / 2 - num('BB_PLATE_T'),
            `centre ±${cx.toFixed(2)},±${cy.toFixed(2)}, outermost ${(cx + reach).toFixed(2)} of ${L / 2}, ${(cy + reach).toFixed(2)} of ${W / 2}`,
          );
          check(
            `xdrive ${L}x${W}: the four wheels clear each other`,
            2 * cx > 2 * reach && 2 * cy > 2 * reach,
            `${(2 * Math.min(cx, cy)).toFixed(2)} apart vs ${(2 * reach).toFixed(2)}`,
          );
        }
      }

      // ── ALL FIVE DRIVETRAINS, AND THE ONE THAT WAS ACTUALLY WRONG ────────────────────────
      // `xdrive` and `butterfly` both used to fall through to the mecanum wheel. X-DRIVE was a
      // BUG: `drawWheels` (the 2D map, shared by all three games) cants its omnis across their
      // corners so the four read as a diamond, and its header explains why that is the machine
      // this sim models — a radial X could never yaw. Drawing them pointing forward in 3D made
      // the same robot a different machine depending on which view key was pressed, so the 3D
      // cant is now THE SAME EXPRESSION. BUTTERFLY was only under-drawn, and now carries both
      // sets with `butterflyTank` deciding which is down.
      {
        const wheelsSrc = readFileSync(join(root, 'src', 'render', 'drawRobot.ts'), 'utf8');
        check(
          'the 2D map still cants its X-drive omnis across their corners',
          /px \* py >= 0 \? -Math\.PI \/ 4 : Math\.PI \/ 4/.test(wheelsSrc),
        );
        check(
          '...and the 3D view cants them by the same rule, not straight ahead',
          /x \* sy >= 0 \? -Math\.PI \/ 4 : Math\.PI \/ 4/.test(robotsCode),
        );
        check(
          'a mecanum roller and an omni roller are different PARTS, not two paintings of one',
          wheelKindOf('mecanum') === 'mecanum' &&
            wheelKindOf('xdrive') === 'omni' &&
            wheelKindOf('butterfly') === 'mecanum' &&
            Math.abs(BB_WHEEL_PARTS.mecanum.rollerAngle - Math.PI / 4) < 1e-12 &&
            Math.abs(BB_WHEEL_PARTS.omni.rollerAngle - Math.PI / 2) < 1e-12,
        );
        check(
          '...and the 2D sprite’s own X-drive got the diamond fix the other two games already had',
          // BIOBUZZ's copy of `drawWheels` drew its omnis RADIALLY (`+45°` on the main diagonal,
          // stretched to `reach * 1.15`) long after DECODE's and CR's were corrected — a wheel
          // whose force line passes through the centre of mass has no moment arm about it, so the
          // sprite was of a machine that could translate and never yaw. Found 2026-09-21.
          /px \* py >= 0 \? -Math\.PI \/ 4 : Math\.PI \/ 4, 'omni', 4\.4, 2\.2, accent/.test(
            readFileSync(join(root, 'src', 'games', 'biobuzz', 'parts.ts'), 'utf8'),
          ),
        );
        const typesSrc = readFileSync(join(root, 'src', 'types.ts'), 'utf8');
        check(
          'butterfly draws BOTH sets and drops the one the sim says is down',
          /^\s*butterflyTank: boolean;$/m.test(typesSrc) &&
            robotsCode.includes("if (dt === 'butterfly')") &&
            robotsCode.includes('r.butterflyTank ? 0 : BB_BUTTERFLY_LIFT'),
        );
        // and none of the five is left sharing another's drawing
        for (const dt of ['mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'] as const) {
          check(`buildWheels branches on ${dt}`, new RegExp(`'${dt}'`).test(robotsCode), dt);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE WHEELS ARE THE REAL PARTS (owner, 2026-09-21: "Make the wheels be rendered
      // accurately. Gobilda 104mm gripforce mecanum wheel, gobilda omni wheel"; then "it makes no
      // sense for the wheel to have slant patterns" / "which is how it is right now")
      // ═══════════════════════════════════════════════════════════════════════════════════════
      //
      // Almost everything here is MEASURED off built geometry rather than grepped, because every
      // claim in the request is about a SHAPE: eleven rollers, at 45°, handed so the four form an
      // X, and nothing slanted anywhere else. A grep can see the constant `11`; it cannot see a
      // wheel whose rollers all lean the same way.
      {
        const DRIVETRAINS = ['mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'] as const;
        const specFor = (dt: (typeof DRIVETRAINS)[number], extra: Record<string, unknown> = {}): RobotSpec =>
          bbCoerceSpec({ ...BB_DEFAULT_SPEC, drivetrain: dt, ...extra } as never);
        /** every world-space triangle of a subtree, as flat triples. */
        const worldVerts = (o: THREE.Object3D): THREE.Vector3[] => {
          o.updateMatrixWorld(true);
          const out: THREE.Vector3[] = [];
          o.traverse((n) => {
            const m = n as THREE.Mesh;
            if (!m.isMesh || !m.geometry) return;
            const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
            if (!pos) return;
            for (let i = 0; i < pos.count; i++) {
              out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
            }
          });
          return out;
        };
        const triCount = (o: THREE.Object3D): number => {
          let n = 0;
          o.traverse((c) => {
            const m = c as THREE.Mesh;
            if (!m.isMesh || !m.geometry) return;
            const idx = m.geometry.getIndex();
            n += (idx ? idx.count : (m.geometry.getAttribute('position')?.count ?? 0)) / 3;
          });
          return Math.round(n);
        };

        // ── (1) THE CATALOGUE. Each number here is PUBLISHED by the manufacturer and cited at
        // the constant that carries it; this is the check that the model still IS that part.
        {
          check(
            'mecanum: the drawn wheel is Ø104 mm — goBILDA’s GripForce mecanum, and C.WHEEL_DIAMETER_MM',
            Math.abs(BB_WHEEL_PARTS.mecanum.r * 2 * 25.4 - 104) < 1e-9 &&
              Math.abs(BB_WHEEL_PARTS.mecanum.r * 2 - C.WHEEL_DIAMETER_MM / 25.4) < 1e-9,
            `${(BB_WHEEL_PARTS.mecanum.r * 2 * 25.4).toFixed(3)} mm vs C.WHEEL_DIAMETER_MM ${C.WHEEL_DIAMETER_MM}`,
          );
          check(
            '...with ELEVEN rollers, which is the one roller count goBILDA publishes',
            BB_WHEEL_PARTS.mecanum.rollers === 11 && BB_WHEEL_PARTS.mecanum.rows === 1,
            `${BB_WHEEL_PARTS.mecanum.rollers} × ${BB_WHEEL_PARTS.mecanum.rows} row`,
          );
          check(
            'omni: Ø96 mm — the LARGEST omni goBILDA sells, so an X-drive is honestly smaller than a mecanum',
            Math.abs(BB_WHEEL_PARTS.omni.r * 2 * 25.4 - 96) < 1e-9 && BB_WHEEL_PARTS.omni.r < BB_WHEEL_PARTS.mecanum.r,
            `${(BB_WHEEL_PARTS.omni.r * 2 * 25.4).toFixed(3)} mm`,
          );
          check(
            '...in TWO rows, which is what the published offset core (8 mm one side, 12 mm the other) means',
            BB_WHEEL_PARTS.omni.rows === 2 && BB_WHEEL_PARTS.omni.rollers > 0,
            `${BB_WHEEL_PARTS.omni.rows} rows × ${BB_WHEEL_PARTS.omni.rollers}`,
          );
          check(
            'traction: Ø96 mm and Ø72 mm Hogbacks, the two sizes the drivetrain and the pod need',
            Math.abs(BB_WHEEL_PARTS.traction.r * 2 * 25.4 - 96) < 1e-9 &&
              Math.abs(BB_WHEEL_PARTS.podTraction.r * 2 * 25.4 - 72) < 1e-9,
            `${(BB_WHEEL_PARTS.traction.r * 2 * 25.4).toFixed(1)} / ${(BB_WHEEL_PARTS.podTraction.r * 2 * 25.4).toFixed(1)} mm`,
          );
          // ⚠️ THE DERIVED WIDTH, RE-DERIVED. goBILDA publishes no mecanum width, and 48 mm is the
          // figure at which the eleven rollers' circumferential projections overlap by ~1.7×.
          // Under 1.0 the wheel has a gap between rollers and drops into it once a revolution —
          // which is the thing this constant exists to avoid, so the bound is checked, not the
          // number.
          {
            const p = BB_WHEEL_PARTS.mecanum;
            const rho = p.r - p.rollerR;
            const overlap = (p.rollerL * Math.sin(p.rollerAngle)) / ((2 * Math.PI * rho) / p.rollers);
            check(
              'mecanum: the rollers OVERLAP in azimuth (so the wheel never rolls into a gap)',
              overlap > 1.2 && overlap < 2.4,
              `${overlap.toFixed(2)}× the pitch`,
            );
            // ...and they still do not interpenetrate: two parallel 45° rollers a chord apart sit
            // `chord·cos45` apart measured PERPENDICULAR to their own axes.
            const perp = 2 * rho * Math.sin(Math.PI / p.rollers) * Math.cos(p.rollerAngle);
            check(
              'mecanum: ...and neighbouring rollers still clear each other',
              2 * p.rollerR < perp - 1e-9,
              `2R ${(2 * p.rollerR).toFixed(3)} vs ${perp.toFixed(3)} apart (gap ${(perp - 2 * p.rollerR).toFixed(3)})`,
            );
          }
        }

        // ── (2) NO PAINTED SLANT ANYWHERE, AT ANY TIER. This is the owner's second message, and
        // it is two claims: the stripe TEXTURE is gone, and nothing that is not a mecanum roller
        // is drawn at an angle to its own axle.
        {
          check(
            'the roller-stripe CanvasTexture is GONE from the scene, not merely unused',
            !/getRollerTexture|getRollerMat|ROLLER_TEX_CACHE|ROLLER_MAT_CACHE/.test(robotsCode),
          );
          // ⚠️ `buildWheels`, NOT `buildRobotGroup`: this lane is DOM-free and the robot SIGN's
          // texture is a real canvas. That the wheels can be built here at all is itself the
          // headline — under the stripe texture, `buildWheels` called `document.createElement` for
          // three of the five drivetrains and could not be exercised in this lane.
          check(
            '...and no wheel material carries a map at all (a texture cannot come back in by another door)',
            (() => {
              for (const dt of DRIVETRAINS) {
                for (const detail of ['low', 'high'] as const) {
                  const w = buildWheels(specFor(dt), undefined, detail);
                  let bad = false;
                  for (const n of w.nodes) {
                    n.traverse((c) => {
                      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
                      if (m && m.map) bad = true;
                    });
                    disposeRobotGroup(n as THREE.Group);
                  }
                  if (bad) return false;
                }
              }
              return true;
            })(),
          );
          // THE ANGLE ITSELF. A roller is a lathe about its own axis, so its axis is the direction
          // its vertex cloud is LONGEST in — measured by the principal axis of the covariance of
          // one roller's vertices, which needs no knowledge of how it was built.
          for (const kind of ['omni', 'traction', 'podTraction'] as const) {
            const w = buildDriveWheel(kind, 'high');
            const rollers = w.getObjectByName('bb-wheel-rollers');
            const vs = worldVerts(w);
            // the wheel's axle is local +y; nothing on a non-mecanum may lean off it by 45°
            const leaning = rollers
              ? (() => {
                  // for an omni every roller is tangential, i.e. its axis has NO y component at
                  // all: so no vertex pair within one roller may be separated mostly along y
                  const p = BB_WHEEL_PARTS[kind];
                  const ys = worldVerts(rollers).map((v) => v.y);
                  const rowSpread = Math.max(...ys) - Math.min(...ys);
                  // two rows of barrels, each at most `2·rollerR` tall in y — a 45° lean would
                  // make a single roller `rollerL·cos45` = far more than that
                  return rowSpread > p.w + 1e-6;
                })()
              : false;
            check(`${kind}: nothing on this wheel leans off the axle (no 45° anywhere)`, !leaning);
            check(
              `${kind}: ...and it stays inside its own published diameter`,
              Math.max(...vs.map((v) => Math.hypot(v.x, v.z))) <= BB_WHEEL_PARTS[kind].r + 1e-6,
              `${Math.max(...vs.map((v) => Math.hypot(v.x, v.z))).toFixed(4)} vs ${BB_WHEEL_PARTS[kind].r.toFixed(4)}`,
            );
            disposeRobotGroup(w);
          }
          check(
            'a traction wheel has a TREAD and no rollers; a roller wheel has rollers and no tread band',
            !!buildDriveWheel('traction', 'high').getObjectByName('bb-wheel-tread') &&
              !buildDriveWheel('traction', 'high').getObjectByName('bb-wheel-rollers') &&
              !!buildDriveWheel('mecanum', 'high').getObjectByName('bb-wheel-rollers') &&
              !buildDriveWheel('mecanum', 'high').getObjectByName('bb-wheel-tread'),
          );
        }

        // ── (3) HANDEDNESS: THE X PATTERN, MEASURED, ON EVERY BUILD THE BUILDER ALLOWS ────────
        //
        // AndyMark, on the equivalent part: "right wheels at the FRONT RIGHT and the REAR LEFT
        // position, while the 'left' wheel would be in the FRONT LEFT and REAR RIGHT." REV: the
        // diagonals the rollers make "should form an 'X' … viewed from above". So: take the
        // TOPMOST roller of each corner wheel (the only one a top-down camera sees), read its axis
        // direction in the chassis plane, and assert the four of them make that X.
        //
        // ⚠️ THE FAILURE THIS CATCHES IS THE CLASSIC ONE — four wheels built the same way, which
        // is a picture of a robot that physically cannot strafe. It passes with all four parallel
        // if you only ever check one wheel, which is why every assertion below is about a PAIR.
        {
          /**
           * THE TOPMOST ROLLER'S AXIS of one built wheel, in the chassis plane, normalized.
           *
           * ⚠️ **ISOLATING ONE ROLLER CANNOT BE DONE BY AZIMUTH OR BY A SLAB OF z, AND BOTH WERE
           * TRIED.** A mecanum roller is 2.36 in long at 45°, so it spans ±27.5° of azimuth while
           * the pitch is only 32.7° — the rollers OVERLAP in azimuth, by design (that overlap is
           * what keeps the wheel in contact). And a slab near the crown clips the barrel down to a
           * nearly circular cap whose principal axis is ill-conditioned, while still catching the
           * tops of both neighbours: measured, that read the front-left wheel's roller at
           * (0.439, 0.898) instead of (0.707, 0.707) and put the two hands 52° apart.
           *
           * What DOES isolate them is the buffer: `rollerGeometries` merges N identical lathes in
           * order, so roller `i` is a contiguous, equal-length run of the merged position
           * attribute. Asserted rather than assumed — an uneven split means the wheel stopped
           * being N copies of one barrel and this measurement no longer means what it says.
           */
          const topRollerDir = (wheel: THREE.Object3D): { x: number; y: number } | null => {
            const rollers = wheel.getObjectByName('bb-wheel-rollers') as THREE.Mesh | null;
            if (!rollers) return null;
            const vs = worldVerts(rollers);
            const part = BB_WHEEL_PARTS.mecanum;
            const n = part.rollers * part.rows;
            if (vs.length === 0 || vs.length % n !== 0) return null;
            const per = vs.length / n;
            let best: THREE.Vector3[] | null = null;
            let bestZ = -Infinity;
            for (let i = 0; i < n; i++) {
              const chunk = vs.slice(i * per, (i + 1) * per);
              const mz = chunk.reduce((a, v) => a + v.z, 0) / per;
              if (mz > bestZ) {
                bestZ = mz;
                best = chunk;
              }
            }
            if (!best) return null;
            const cx = best.reduce((a, v) => a + v.x, 0) / per;
            const cy = best.reduce((a, v) => a + v.y, 0) / per;
            // principal axis of the 2×2 covariance, in closed form
            let sxx = 0;
            let syy = 0;
            let sxy = 0;
            for (const v of best) {
              sxx += (v.x - cx) ** 2;
              syy += (v.y - cy) ** 2;
              sxy += (v.x - cx) * (v.y - cy);
            }
            const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
            return { x: Math.cos(theta), y: Math.sin(theta) };
          };
          const parallel = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
            Math.abs(a.x * b.x + a.y * b.y);

          for (const dt of ['mecanum', 'butterfly'] as const) {
            // EVERY intake mount the builder allows, because the mount changes the footprint and
            // the end plates and was the thing most likely to reorder the corner loop
            for (const mount of ['front', 'back', 'frontback', 'left', 'right'] as const) {
              const spec = specFor(dt, { bbMech: { ...BB_DEFAULT_SPEC.bbMech, intakeMount: mount } });
              const wheels = buildWheels(spec, undefined, 'high');
              const hl = spec.length / 2;
              // the four CORNER wheels: for butterfly the `spin` list also holds the inboard
              // traction twins, which have no rollers and are skipped by `topRollerDir`
              const corners = wheels.spin
                .map((w) => w.node)
                .filter((n) => topRollerDir(n) !== null);
              const tag = `${dt}/${mount}`;
              check(`X-pattern/${tag}: four handed wheels were built`, corners.length === 4, String(corners.length));
              if (corners.length !== 4) continue;
              // index them by quadrant rather than by loop order, so this cannot be fooled by the
              // order `axleXs` happens to yield
              const at = (sx: number, sy: number): THREE.Object3D | undefined =>
                corners.find((n) => Math.sign(n.position.x || 1) === sx && Math.sign(n.position.y) === sy);
              const fl = at(1, 1);
              const fr = at(1, -1);
              const bl = at(-1, 1);
              const br = at(-1, -1);
              check(`X-pattern/${tag}: one wheel per quadrant`, !!fl && !!fr && !!bl && !!br);
              if (!fl || !fr || !bl || !br) continue;
              const dFL = topRollerDir(fl)!;
              const dFR = topRollerDir(fr)!;
              const dBL = topRollerDir(bl)!;
              const dBR = topRollerDir(br)!;
              check(
                `X-pattern/${tag}: FRONT-LEFT and REAR-RIGHT carry the same hand`,
                parallel(dFL, dBR) > 0.999,
                `${parallel(dFL, dBR).toFixed(4)}`,
              );
              check(
                `X-pattern/${tag}: FRONT-RIGHT and REAR-LEFT carry the same hand`,
                parallel(dFR, dBL) > 0.999,
                `${parallel(dFR, dBL).toFixed(4)}`,
              );
              check(
                `X-pattern/${tag}: ...and the two hands are PERPENDICULAR — the X, not four of one`,
                parallel(dFL, dFR) < 0.001,
                `${parallel(dFL, dFR).toFixed(4)}`,
              );
              check(
                `X-pattern/${tag}: the front-left wheel's top roller lies on the y = x diagonal`,
                Math.abs(Math.abs(dFL.x) - Math.SQRT1_2) < 0.02 && Math.abs(dFL.x * dFL.y) > 0.49,
                `(${dFL.x.toFixed(3)}, ${dFL.y.toFixed(3)})`,
              );
              // and it is the same predicate the 2D sprite hatches by, so the two views agree
              check(
                `X-pattern/${tag}: the 3D hand is the 2D sprite's own expression`,
                robotsCode.includes('const hand: 1 | -1 = x * sy >= 0 ? 1 : -1;') &&
                  readFileSync(join(root, 'src', 'games', 'biobuzz', 'parts.ts'), 'utf8').includes(
                    'const s = px * py >= 0 ? 1 : -1;',
                  ),
              );
              for (const n of wheels.nodes) disposeRobotGroup(n as THREE.Group);
              void hl;
            }
          }
        }

        // ── (4) NOTHING POKES OUT OF THE CHASSIS. The owner had the top plate made full-footprint
        // and the corner plates added to hide the wheels on 2026-09-20/21; a wheel that grew
        // 0.094 in in the radius and 0.39 in in the width must still be under both.
        {
          const deckUnder = BB_DECK_Z - 0.26;
          for (const dt of DRIVETRAINS) {
            const spec = specFor(dt);
            const wheels = buildWheels(spec, undefined, 'high');
            const hl = spec.length / 2;
            const hw = spec.width / 2;
            let maxZ = -Infinity;
            let minZ = Infinity;
            let outX = 0;
            let outY = 0;
            for (const n of wheels.nodes) {
              for (const v of worldVerts(n)) {
                maxZ = Math.max(maxZ, v.z);
                minZ = Math.min(minZ, v.z);
                outX = Math.max(outX, Math.abs(v.x) - hl);
                outY = Math.max(outY, Math.abs(v.y) - hw);
              }
            }
            check(`fit/${dt}: the drivetrain has geometry to measure`, Number.isFinite(maxZ), `${maxZ.toFixed(3)}`);
            check(
              `fit/${dt}: nothing on a wheel crosses the frame line in x or y`,
              outX <= 1e-6 && outY <= 1e-6,
              `x +${outX.toFixed(4)}, y +${outY.toFixed(4)}`,
            );
            check(
              `fit/${dt}: no wheel reaches the DECK's underside (it would poke through the top plate)`,
              maxZ <= deckUnder + 1e-6,
              `${maxZ.toFixed(3)} vs ${deckUnder.toFixed(3)}`,
            );
            check(`fit/${dt}: and nothing is below the floor`, minZ >= -1e-6, `${minZ.toFixed(4)}`);
            // the LIFTED butterfly set is the case that nearly broke this: a 0.6-in lift under a
            // 104 mm wheel puts its crown through the lid
            if (dt === 'butterfly') {
              // the lift is derived against this very ceiling (`BB_BUTTERFLY_LIFT`), so re-derive
              // it here rather than reading it: a typed 0.6 under a 104 mm wheel is 4.694 through
              // a lid at 4.34, and that is exactly the regression this guards
              const lift = Math.min(0.6, deckUnder - 2 * BB_WHEEL_PARTS.mecanum.r);
              check(
                'fit/butterfly: a LIFTED mecanum set still clears the deck',
                lift > 0 && 2 * BB_WHEEL_PARTS.mecanum.r + lift <= deckUnder + 1e-9,
                `lift ${lift.toFixed(3)} → crown ${(2 * BB_WHEEL_PARTS.mecanum.r + lift).toFixed(3)} vs ${deckUnder.toFixed(3)}`,
              );
              check(
                'fit/butterfly: ...and the lift is DERIVED from the deck, not typed',
                robotsCode.includes('const BB_BUTTERFLY_LIFT = Math.min(0.6, BB_DECK_Z - 0.26 - 2 * BB_MECANUM.r);'),
              );
            }
            for (const n of wheels.nodes) disposeRobotGroup(n as THREE.Group);
          }
        }

        // ── (5) THE TIERS. The rule is that a tier changes the TESSELLATION and nothing else, so
        // both halves are asserted: the triangle count really does drop, and the machine really
        // does not change.
        {
          const budget: Record<string, [number, number]> = {
            // kind: [low ceiling, high ceiling] triangles per wheel
            mecanum: [700, 3600],
            omni: [1000, 4200],
            traction: [500, 2600],
            podTraction: [500, 2600],
          };
          for (const kind of ['mecanum', 'omni', 'traction', 'podTraction'] as const) {
            const lo = buildDriveWheel(kind, 'low');
            const hi = buildDriveWheel(kind, 'high');
            const nLo = triCount(lo);
            const nHi = triCount(hi);
            check(`tier/${kind}: LOW is inside its triangle budget`, nLo <= budget[kind][0], `${nLo} tris`);
            check(`tier/${kind}: HIGH is inside its triangle budget`, nHi <= budget[kind][1], `${nHi} tris`);
            check(`tier/${kind}: LOW is genuinely cheaper than HIGH`, nLo < nHi * 0.6, `${nLo} vs ${nHi}`);
            // ⚠️ AND THE SHAPE IS THE SAME MACHINE. The outer diameter, the roller count and the
            // roller angle are the part, not the budget — a tier may not quietly drop rollers.
            const rad = (o: THREE.Object3D): number =>
              Math.max(...worldVerts(o).map((v) => Math.hypot(v.x, v.z)));
            check(
              `tier/${kind}: LOW and HIGH are the same wheel — same outer radius, to a tessellation chord`,
              Math.abs(rad(lo) - rad(hi)) < 0.12,
              `${rad(lo).toFixed(3)} vs ${rad(hi).toFixed(3)}`,
            );
            disposeRobotGroup(lo);
            disposeRobotGroup(hi);
          }
          // a LOW mecanum still has eleven real rollers, which is the whole claim of "simplified,
          // not different": measure them as separated vertex clusters in azimuth
          {
            const lo = buildDriveWheel('mecanum', 'low');
            const rollers = lo.getObjectByName('bb-wheel-rollers');
            const azim = new Set(
              worldVerts(rollers!).map((v) => Math.round((Math.atan2(v.z, v.x) * 11) / (Math.PI * 2))),
            );
            check(
              'tier/mecanum: a LOW wheel still carries eleven separate rollers',
              azim.size >= 11,
              `${azim.size} azimuth buckets`,
            );
            disposeRobotGroup(lo);
          }
          // ...and the tier mapping itself: Low+Medium cheap, High+Ultra full, and `meshDetail`
          // honoured wherever it is set by hand
          check(
            'tier/map: Low and Medium take the cheap wheel, High and Ultra the full one',
            bbWheelDetail(GFX_PRESETS.low, 'low') === 'low' &&
              bbWheelDetail(GFX_PRESETS.medium, 'medium') === 'low' &&
              bbWheelDetail(GFX_PRESETS.high, 'high') === 'high' &&
              bbWheelDetail(GFX_PRESETS.ultra, 'ultra') === 'high',
          );
          check(
            'tier/map: a hand-set meshDetail of `low` is honoured on any column',
            bbWheelDetail({ meshDetail: 'low' }, 'ultra') === 'low',
          );
          check(
            'tier/map: ...and NO seventeenth graphics setting was added for this',
            !/wheelDetail\s*:/.test(readFileSync(join(root, 'src', 'games', 'biobuzz', 'graphics', 'settings.ts'), 'utf8')),
          );
          check(
            'tier/map: the scene pushes it at the robots on every settings change',
            readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderScene.ts'), 'utf8').includes(
              'this.robots.wheelDetail = bbWheelDetail(s, this.tier);',
            ),
          );
        }

        // ── (6) THE POSE HANDLES SURVIVED. Swerve steer, butterfly drop and the new wheel roll
        // are all `userData` contracts the per-frame sync reads; a rebuild that dropped one would
        // freeze a drivetrain silently.
        {
          // ⚠️ AGAIN `buildWheels` AND A SOURCE LINE, NOT `buildRobotGroup` — the robot SIGN is a
          // canvas texture and this lane has no DOM. `buildWheels` produces the three lists; the
          // grep is the one step this cannot build, that `buildRobotGroup` publishes them under
          // the names the sync reads.
          for (const ud of ['swervePods', 'butterflySets', 'spinWheels'] as const) {
            check(
              `handles: buildRobotGroup still publishes userData.${ud}`,
              robotsCode.includes(`group.userData.${ud} = `),
            );
          }
          for (const dt of DRIVETRAINS) {
            const w = buildWheels(specFor(dt), undefined, 'high');
            check(
              `handles/${dt}: every wheel is published with its OWN rolling radius`,
              w.spin.length > 0 && w.spin.every((s) => s.r > 0.5 && s.r <= BB_WHEEL_PARTS.mecanum.r + 1e-9),
              `${w.spin.length} wheels`,
            );
            if (dt === 'swerve') {
              check('handles/swerve: four pods, in corner order', w.pods.length === 4);
              check('handles/swerve: ...and each pod’s wheel is in the spin list', w.spin.length === 4);
            }
            if (dt === 'butterfly') {
              check('handles/butterfly: both sets are published, four each', w.traction.length === 4 && w.roller.length === 4);
              check(
                'handles/butterfly: ...each with its OWN grounded height (two different parts)',
                Math.abs(w.traction[0].z - BB_WHEEL_PARTS.traction.r) < 1e-9 &&
                  Math.abs(w.roller[0].z - BB_WHEEL_PARTS.mecanum.r) < 1e-9,
                `${w.traction[0].z.toFixed(3)} / ${w.roller[0].z.toFixed(3)}`,
              );
            }
            if (dt === 'tank') {
              check('handles/tank: six wheels turn, not four', w.spin.length === 6, `${w.spin.length}`);
            }
            for (const n of w.nodes) disposeRobotGroup(n as THREE.Group);
          }
          // ⚠️ THE ROLL HAS TO HAPPEN INSIDE THE X-DRIVE'S CANT, or a canted wheel spins about the
          // wrong axis and reads as a skid. A `THREE.Euler` defaults to `XYZ`, which applies `z`
          // first; `ZYX` is what puts the roll under it.
          check(
            'spin: a drive wheel rotates ZYX, so an X-drive’s roll stays inside its 45° cant',
            buildDriveWheel('omni', 'high').rotation.order === 'ZYX' &&
              robotsCode.includes("g.rotation.order = 'ZYX';"),
          );
          check(
            'spin: the roll is driven off the sim’s own velocity, at each wheel’s own radius',
            robotsCode.includes('w.node.rotation.y -= (v / w.r) * dt;'),
          );
          check(
            'spin: and `effects: minimal` stops it (the §4.4 row that had nothing behind it)',
            robotsCode.includes('if (wheelSpin)') &&
              readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderScene.ts'), 'utf8').includes(
                "this.robots.wheelSpin = s.effects !== 'minimal';",
              ),
          );
        }
      }

      // ── #14: THE INTAKE REACHES THE SIM'S OWN FOOTPRINT ─────────────────────────────────
      // Read from `bbMouths`, never a literal and never a copy of the reach constant: Lane D may
      // lengthen the reach and the model has to follow it without an edit here.
      check(
        'the 3D intake is built from bbMouths/bbMouthFrame, the capture rects themselves',
        robotsCode.includes('for (const m of bbMouths(spec))') && robotsCode.includes('bbMouthFrame(m, hl, hw)'),
      );
      check(
        '...and renderRobots names no intake constant of its own',
        !/INTAKE_PRESETS/.test(robotsCode) && !/\.reach/.test(robotsCode),
      );
      // ARITHMETIC, not a grep: for every mount, the mouth the model is built in reaches exactly
      // the collision extent of that edge, and reaches PAST the frame — which is the complaint.
      {
        const mk = (over: Partial<RobotSpec>): RobotSpec => bbCoerceSpec({ ...BB_DEFAULT_SPEC, ...over } as RobotSpec);
        for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
          const spec = mk({ intakeMount: mount });
          const fx = bbFootprint(spec);
          const hl = spec.length / 2;
          const hw = spec.width / 2;
          for (const m of bbMouths(spec)) {
            const outer =
              m.edge === 'front' ? m.x1 : m.edge === 'back' ? -m.x0 : m.edge === 'left' ? m.y1 : -m.y0;
            const want = m.edge === 'front' ? fx.front : m.edge === 'back' ? fx.rear : fx.half;
            const frame = m.edge === 'front' || m.edge === 'back' ? hl : hw;
            check(
              `intake ${mount}/${m.edge}: the drawn mouth reaches the collision extent`,
              Math.abs(outer - want) < 1e-9,
              `${outer.toFixed(3)} vs ${want.toFixed(3)}`,
            );
            check(
              `intake ${mount}/${m.edge}: and it reaches PAST the frame (else nothing sticks out)`,
              outer - frame > 1,
              `${(outer - frame).toFixed(3)} in`,
            );
          }
        }
      }
      // the 2D sprite is built from the same rects and puts its outer roller just inside the tip,
      // so the two views cannot under-draw the reach differently
      const spriteSrc = readFileSync(join(BIOBUZZ_DIR, 'drawRobot.ts'), 'utf8');
      check(
        'the 2D sprite draws the same mouths, out to the same tip',
        spriteSrc.includes('for (const m of bbMouths(r.spec))') && spriteSrc.includes('const outer = d - 0.95;'),
      );
      check('the muzzle height both renderers use is the sim’s release height', BB_LAUNCH_Z0 > 0 && robotsCode.includes('BB_LAUNCH_Z0'));

      /**
       * ── 2026-09-19 OWNER: THE FRONT BRACE ────────────────────────────────────────────────
       * *"The intake plates stick out further than the intake rollers so the hitboxes are
       * weird... add a bracing across the two intake plates in the front"*, and then *"let's do
       * a bracing in the front then, to make the collision hitbox a long rectangle across in the
       * front"*. The solve's half is `chassis3dPocketShapes`; this is the PICTURE's half, and
       * the two must say the same thing: a bar the full mouth width, ending on the tip line, its
       * underside one NECTAR diameter up so an element still passes under into the mouth.
       *
       * Measured on the built GROUP, not grepped: every vertex of every intake node, in the
       * mouth's own frame, against the tip line. A plate that grows back past the roller, or a
       * brace that slips down into the element's path, fails here.
       */
      {
        const mk = (over: Partial<RobotSpec>): RobotSpec => bbCoerceSpec({ ...BB_DEFAULT_SPEC, ...over } as RobotSpec);
        for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
          for (const chainIntake of ['sloped', 'vector', 'triangle'] as const) {
            const spec = mk({ intakeMount: mount, chainIntake } as Partial<RobotSpec>);
            const group = new THREE.Group();
            for (const n of buildIntake(spec).nodes) group.add(n);
            group.updateMatrixWorld(true);
            const hl = spec.length / 2;
            const hw = spec.width / 2;
            for (const m of bbMouths(spec)) {
              const f = bbMouthFrame(m, hl, hw);
              const node = group.getObjectByName(`robot:intake:${m.edge}`);
              const brace = group.getObjectByName(`robot:intake:brace:${m.edge}`);
              if (!node || !brace) {
                check(`intake ${mount}/${chainIntake}/${m.edge}: the front brace exists`, false, 'no node');
                continue;
              }
              /**
               * every vertex, carried into the MOUTH's own frame (+x OUTWARD from its origin).
               * ⚠️ The tolerance is 0.06 in and it is MEASURED, not chosen: the arm's DIAGONAL
               * member is a rotated box, so half its 0.34-in thickness projects 0.0496 in past
               * the line its centre ends on. That predates this pass and is a rotated member's
               * corner, not a plate reaching past the roller — which is what the check is for.
               */
              const OVERHANG = 0.06;
              const along = (o: THREE.Object3D): number => {
                let best = -Infinity;
                const v = new THREE.Vector3();
                o.traverse((n) => {
                  const g3 = (n as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
                  const pos = g3?.getAttribute?.('position');
                  if (!pos) return;
                  for (let i = 0; i < pos.count; i++) {
                    v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(n.matrixWorld);
                    best = Math.max(best, (v.x - f.ox) * Math.cos(f.rot) + (v.y - f.oy) * Math.sin(f.rot));
                  }
                });
                return best;
              };
              const outer = along(node);
              const braceOut = along(brace);
              const bb = new THREE.Box3().setFromObject(brace);
              const span = m.edge === 'front' || m.edge === 'back' ? bb.max.y - bb.min.y : bb.max.x - bb.min.x;
              check(
                `intake ${mount}/${chainIntake}/${m.edge}: nothing drawn reaches past the collision tip`,
                outer <= f.depth + OVERHANG,
                `outermost vertex ${outer.toFixed(4)} vs tip ${f.depth.toFixed(4)}`,
              );
              check(
                `intake ${mount}/${chainIntake}/${m.edge}: the front brace spans the mouth and ends on the tip`,
                span > f.half * 2 - 1.5 && Math.abs(braceOut - f.depth) < 1e-6,
                `span ${span.toFixed(2)} of ${(f.half * 2).toFixed(2)}, brace face ${braceOut.toFixed(4)} vs tip ${f.depth.toFixed(4)}`,
              );
              check(
                `intake ${mount}/${chainIntake}/${m.edge}: an element still passes under the brace`,
                bb.min.z >= 2 * BB_NECTAR_R - 1e-6,
                `underside ${bb.min.z.toFixed(3)} vs a NECTAR's ${(2 * BB_NECTAR_R).toFixed(3)}`,
              );
            }
          }
        }
      }

      // ── 2026-09-19 OWNER PLAYTEST: THE INTAKE'S SIDES, AND PASSING UNDER THE ROLLER ───────
      // "its sides must not be solid aluminium plate" and "it should still allow for pollen and
      // nectar to pass under". Both were the picture claiming solid the COLLIDER does not have:
      // `chassis3dShapes` gives the mouth a bare rail and leaves the pocket open from the tiles
      // to `BB3_MOUTH_SLOT_Z`, and the roller is not a collider in either backend.
      {
        const num = (name: string): number => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(robotsSrc)?.[1] ?? NaN);
        check(
          'the intake arm is an OPEN TRUSS, not a solid plate',
          // the members are named in COMMENTS, so this reads the raw source: `codeLines` strips
          // them, which is right for the arithmetic greps and wrong for this one
          !/platePlane\(armLen/.test(robotsCode) &&
            robotsSrc.includes('THE BOTTOM RAIL') &&
            robotsSrc.includes('THE AXLE BOSS') &&
            robotsSrc.includes('THE DIAGONAL'),
        );
        check(
          '...and no member of it is thicker than the flank rail the COLLIDER claims',
          robotsCode.includes('const armT = INTAKE_RAIL_T;') && INTAKE_RAIL_T > 0,
          `${INTAKE_RAIL_T} in`,
        );
        // PASS-UNDER, as arithmetic over the deflection law itself. The rigid flap swept to
        // `BB_ROLLER_FLAP_R` and blocked the pocket by 1.10 in; a hinged flap folds back as it
        // reaches the floor of the sweep, which is what a compliant flap physically does.
        const hubR = num('BB_ROLLER_HUB_R');
        const flapR = num('BB_ROLLER_FLAP_R');
        const flapT = num('BB_ROLLER_FLAP_T');
        const rollerZ = BB3_MOUTH_SLOT_Z + hubR + 0.15;
        const passZ = BB3_MOUTH_SLOT_Z + flapT / 2;
        const L = flapR - hubR;
        check(
          'the roller HUB still clears the collider’s open pocket on its own',
          rollerZ - hubR >= BB3_MOUTH_SLOT_Z,
          `hub bottom ${(rollerZ - hubR).toFixed(2)} vs slot ${BB3_MOUTH_SLOT_Z}`,
        );
        check(
          'a RIGID flap of this length would block it — which is the bug being fixed',
          rollerZ - flapR < BB3_MOUTH_SLOT_Z,
          `${(BB3_MOUTH_SLOT_Z - (rollerZ - flapR)).toFixed(2)} in of intrusion`,
        );
        {
          // walk a full turn, re-deriving the fold law rather than importing it: a flap is a
          // straight segment from its hinge on the hub rim to its tip, so the segment's lowest
          // point is one of its two ends and the envelope is the minimum over both
          const target = passZ - rollerZ;
          const foldAt = (a: number): number => {
            const s = (target - hubR * Math.sin(a)) / L;
            if (Math.sin(a) >= s) return 0;
            return Math.max(0, a - (Math.PI - Math.asin(Math.max(-1, Math.min(1, s)))));
          };
          let lowest = Infinity;
          let foldMax = 0;
          for (let i = 0; i < 1440; i++) {
            const a = (i * Math.PI * 2) / 1440;
            const fold = foldAt(a);
            foldMax = Math.max(foldMax, fold);
            const hz = Math.sin(a) * hubR;
            const tz = hz + Math.sin(a - fold) * L;
            lowest = Math.min(lowest, rollerZ + Math.min(hz, tz) - flapT / 2);
          }
          check(
            'AN ELEMENT PASSES UNDER: the drawn flap envelope never enters the collider’s pocket',
            lowest >= BB3_MOUTH_SLOT_Z - 1e-9,
            `lowest ${lowest.toFixed(3)} vs slot ${BB3_MOUTH_SLOT_Z}`,
          );
          check(
            '...and it yields only where it has to — no fold at all over the top of the sweep',
            foldMax > 1 && foldAt(Math.PI / 2) === 0 && foldAt(0) === 0,
            `max fold ${((foldMax * 180) / Math.PI).toFixed(0)}°`,
          );
        }
        check(
          '...and the flaps are posed every frame, running or not (a stopped roller blocks too)',
          robotsCode.includes('for (let k = 0; k < roller.flaps.length; k++)') &&
            !/if \(running\) \{?\s*for \(let k/.test(robotsCode),
        );
        check(
          '...off ONE deflection law, so the check above is measuring the drawn part',
          /function flapFold\(a: number\): number/.test(robotsCode) &&
            robotsCode.includes('const fold = flapFold(a);'),
        );
      }

      // ── 2026-09-20 OWNER: "INTAKING FROM THE FLOWER SHOULD NOW ONLY BE DONE IF IT IS
      // PHYSICALLY POSSIBLE" — THE THREE INTAKE ARCHETYPES ────────────────────────────────────
      // `siderollers` and `ramp` are extra hardware on the SAME sweeper every build already
      // carries (`bbIntakeKindOf`); the sweeper's own drawing must not move a vertex — every
      // check above this one already re-runs on the sweeper path (it is `mk`'s default, no
      // `bbMech.intake` override), so it is already the byte-identical proof. What is new here
      // is measured on the BUILT group, the same style as the front brace above: "the drawn part
      // that reaches is the part `bbFlowerReachOf` credits" (`config.ts`'s own header).
      {
        const mk = (over: Partial<RobotSpec>): RobotSpec => bbCoerceSpec({ ...BB_DEFAULT_SPEC, ...over } as RobotSpec);
        const num = (name: string): number => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(robotsSrc)?.[1] ?? NaN);
        const flapR = num('BB_ROLLER_FLAP_R');
        const hubR = num('BB_ROLLER_HUB_R');
        const rollerZ = BB3_MOUTH_SLOT_Z + hubR + 0.15;

        check(
          'the ramp pivots on the sweeper’s own axle line — BB_RAMP_PIVOT_BACK is BB_ROLLER_FLAP_R',
          Number.isFinite(flapR) && Math.abs(BB_RAMP_PIVOT_BACK - flapR) < 1e-9,
          `${BB_RAMP_PIVOT_BACK} vs ${flapR}`,
        );
        check(
          'the archetype vocabulary is exactly the three kinds this lane tests',
          BB_INTAKE_KINDS.length === 3 && BB_INTAKE_KINDS.includes('siderollers') && BB_INTAKE_KINDS.includes('ramp'),
          BB_INTAKE_KINDS.join(','),
        );

        // a vertex → (u, v, z) in the MOUTH's own frame: u outward past the tip, v across the
        // mouth, z off the tiles. The same projection the front-brace check above uses for u
        // alone, generalised to all three axes so the ramp's deployed pose can be measured too.
        const mouthExtent = (o: THREE.Object3D, f: { ox: number; oy: number; rot: number }) => {
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, zMin = Infinity, zMax = -Infinity;
          const v3 = new THREE.Vector3();
          o.traverse((n) => {
            const g3 = (n as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
            const pos = g3?.getAttribute?.('position');
            if (!pos) return;
            for (let i = 0; i < pos.count; i++) {
              v3.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(n.matrixWorld);
              const dx = v3.x - f.ox;
              const dy = v3.y - f.oy;
              const u = dx * Math.cos(f.rot) + dy * Math.sin(f.rot);
              const v = -dx * Math.sin(f.rot) + dy * Math.cos(f.rot);
              uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
              vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
              zMin = Math.min(zMin, v3.z); zMax = Math.max(zMax, v3.z);
            }
          });
          return { uMin, uMax, vMin, vMax, zMin, zMax };
        };
        /** every vertex of `o`, in the mouth's own (u, v, z) frame — `mouthExtent`'s own loop
         *  without the min/max, for checks that need the SHAPE and not just its box (the
         *  side-roller yoke's open working arc). */
        const mouthPoints = (o: THREE.Object3D, f: { ox: number; oy: number; rot: number }) => {
          const out: { u: number; v: number; z: number }[] = [];
          const v3 = new THREE.Vector3();
          o.traverse((n) => {
            const g3 = (n as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
            const pos = g3?.getAttribute?.('position');
            if (!pos) return;
            for (let i = 0; i < pos.count; i++) {
              v3.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(n.matrixWorld);
              const dx = v3.x - f.ox;
              const dy = v3.y - f.oy;
              out.push({
                u: dx * Math.cos(f.rot) + dy * Math.sin(f.rot),
                v: -dx * Math.sin(f.rot) + dy * Math.cos(f.rot),
                z: v3.z,
              });
            }
          });
          return out;
        };

        for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
          for (const kind of BB_INTAKE_KINDS) {
            const spec = mk({ intakeMount: mount, bbMech: { intake: { kind } } } as Partial<RobotSpec>);
            const built = buildIntake(spec);
            const group = new THREE.Group();
            for (const n of built.nodes) group.add(n);
            group.updateMatrixWorld(true);
            const hl = spec.length / 2;
            const hw = spec.width / 2;
            const mouths = bbMouths(spec);
            const label = `intake ${mount}/${kind}`;

            if (kind === 'sweeper') {
              check(
                `${label}: builds no side-roller or ramp hardware`,
                built.sideRollers.length === 0 && built.rampPivots.length === 0,
                `${built.sideRollers.length} rollers, ${built.rampPivots.length} pivots`,
              );
              check(
                `${label}: and no such node is anywhere in the group`,
                group.getObjectByName(`robot:sideroller:${mouths[0].edge}:l`) === undefined &&
                  group.getObjectByName(`robot:ramp:${mouths[0].edge}`) === undefined,
              );
              continue;
            }

            if (kind === 'siderollers') {
              check(
                `${label}: one wheel pair per mouth`,
                built.sideRollers.length === mouths.length * 2,
                `${built.sideRollers.length} vs ${mouths.length * 2}`,
              );
              for (const m of mouths) {
                const f = bbMouthFrame(m, hl, hw);
                for (const side of ['l', 'r'] as const) {
                  const wheel = group.getObjectByName(`robot:sideroller:${m.edge}:${side}`);
                  if (!wheel) {
                    check(`${label}/${m.edge}/${side}: the wheel node exists`, false);
                    continue;
                  }
                  const ext = mouthExtent(wheel, f);
                  // `BB_SIDE_ROLLER_REACH.out` is measured FROM THE TIP LINE (`config.ts`'s own
                  // header); the built wheel sits at absolute mouth-local u = tip + that reach.
                  const outMin = ext.uMin - f.depth;
                  const outMax = ext.uMax - f.depth;
                  check(
                    `${label}/${m.edge}/${side}: reaches exactly BB_SIDE_ROLLER_REACH.out past the tip`,
                    Math.abs(outMin - BB_SIDE_ROLLER_REACH.out[0]) < 1e-6 &&
                      Math.abs(outMax - BB_SIDE_ROLLER_REACH.out[1]) < 1e-6,
                    `[${outMin.toFixed(6)}, ${outMax.toFixed(6)}] vs [${BB_SIDE_ROLLER_REACH.out[0]}, ${BB_SIDE_ROLLER_REACH.out[1]}]`,
                  );
                  check(
                    `${label}/${m.edge}/${side}: and BB_SIDE_ROLLER_REACH.z`,
                    Math.abs(ext.zMin - BB_SIDE_ROLLER_REACH.z[0]) < 1e-6 &&
                      Math.abs(ext.zMax - BB_SIDE_ROLLER_REACH.z[1]) < 1e-6,
                    `[${ext.zMin.toFixed(6)}, ${ext.zMax.toFixed(6)}] vs [${BB_SIDE_ROLLER_REACH.z[0]}, ${BB_SIDE_ROLLER_REACH.z[1]}]`,
                  );
                  const edgeV = bbSideRollerY(f.half);
                  const wantV = side === 'l' ? edgeV : -edgeV;
                  const centreV = (ext.vMin + ext.vMax) / 2;
                  check(
                    `${label}/${m.edge}/${side}: centred at ±bbSideRollerY(f.half) off the mouth centreline`,
                    Math.abs(centreV - wantV) < 1e-6,
                    `${centreV.toFixed(6)} vs ${wantV}`,
                  );
                }
              }

              // ⚠️ EDGE CONTAINMENT (owner, 2026-09-20: "situated on the edges of the robot, not
              // near the center"): whatever the chassis size, a wheel's OUTER face must stay
              // inside the mouth's own lateral edge — the whole point of the edge mount is a
              // wheel BESIDE the opening, never poking past the chassis it is bolted to. Checked
              // across the legal size range, not just `BB_DEFAULT_SPEC`, since `bbSideRollerY`
              // is a function of `f.half` and a small chassis is the tight case.
              for (const [length, width] of [
                [BB_MIN_LENGTH, BB_MIN_WIDTH],
                [BB_DEFAULT_SPEC.length, BB_DEFAULT_SPEC.width],
                [BB_MAX_LENGTH, BB_MAX_WIDTH],
              ] as const) {
                const szSpec = mk({ length, width, intakeMount: mount, bbMech: { intake: { kind } } } as Partial<RobotSpec>);
                for (const sm of bbMouths(szSpec)) {
                  const sf = bbMouthFrame(sm, szSpec.length / 2, szSpec.width / 2);
                  const outerFace = bbSideRollerY(sf.half) + BB_SIDE_ROLLER_R;
                  check(
                    `${label}/${sm.edge}/${length}x${width}: the wheel's outer face stays inside the mouth's lateral edge`,
                    outerFace <= sf.half + 1e-9,
                    `${outerFace.toFixed(6)} vs half ${sf.half.toFixed(6)}`,
                  );
                }
              }

              /**
               * ⚠️ **THE WHEEL MAY NOT BE COVERED** (owner, 2026-09-21, rejecting the housed
               * module that these checks used to pin: "The side rollers are rendered as being
               * covered and still sticking out a ton. It cant be covered fully because it needs
               * to actually touch the balls"). The bracket is a REAR YOKE now — two straps from
               * the side arm's rail to the AXLE, ending in a bearing boss — and what is asserted
               * is the opposite of what was asserted before:
               *
               *  · nothing in the bracket stands forward of the AXLE LINE except the boss, and
               *    nothing reaches past the wheel's own solid front either;
               *  · the working arc is open — swept round the tread from above, the first angle at
               *    which any bracket vertex occludes it is at least `MIN_OPEN_ARC / 2` off the
               *    outward direction, at EVERY height of the wheel;
               *  · the straps still sandwich the wheel without cutting into it, and the bottom one
               *    still clears a FLOWER's lower ring rim (what sets `BB_SIDE_ROLLER_PLATE_T`).
               */
              const MIN_OPEN_ARC = 200; // degrees of tread that must stay visible (owner: "~200")
              for (const m of mouths) {
                const f = bbMouthFrame(m, hl, hw);
                const front = f.depth + BB_SIDE_ROLLER_PROTRUDE;
                const axleU = f.depth + BB_SIDE_ROLLER_OUT;
                const names = [
                  `robot:sideroller:yoke:top:${m.edge}`,
                  `robot:sideroller:yoke:bot:${m.edge}`,
                  `robot:sideroller:axle:${m.edge}`,
                  `robot:sideroller:web:${m.edge}`,
                ];
                for (const nm of names) {
                  const node = group.getObjectByName(nm);
                  const tag = nm.split(':').slice(2, -1).join(':');
                  check(`${label}/${m.edge}: ${tag} exists`, node !== undefined);
                  if (!node) continue;
                  const ext = mouthExtent(node, f);
                  check(
                    `${label}/${m.edge}: ${tag} reaches no further out than the wheel's own solid`,
                    ext.uMax <= front + 1e-6,
                    `uMax ${ext.uMax.toFixed(6)} vs ${front.toFixed(6)}`,
                  );
                  check(
                    `${label}/${m.edge}: ${tag} stands no further forward than the axle line plus the boss`,
                    ext.uMax <= axleU + BB_SIDE_ROLLER_BOSS_R + 1e-6,
                    `uMax ${ext.uMax.toFixed(6)} vs axle ${axleU.toFixed(6)} + boss ${BB_SIDE_ROLLER_BOSS_R}`,
                  );
                }
                const top = group.getObjectByName(`robot:sideroller:yoke:top:${m.edge}`);
                const bot = group.getObjectByName(`robot:sideroller:yoke:bot:${m.edge}`);
                if (top && bot) {
                  const te = mouthExtent(top, f);
                  const be = mouthExtent(bot, f);
                  check(
                    `${label}/${m.edge}: the two straps sandwich the wheel and never cut into it`,
                    Math.abs(te.zMin - BB_SIDE_ROLLER_REACH.z[1]) < 1e-6 && Math.abs(be.zMax - BB_SIDE_ROLLER_REACH.z[0]) < 1e-6,
                    `top zMin ${te.zMin.toFixed(4)} vs ${BB_SIDE_ROLLER_REACH.z[1]}, bot zMax ${be.zMax.toFixed(4)} vs ${BB_SIDE_ROLLER_REACH.z[0]}`,
                  );
                  // ⚠️ the bottom strap is the one part of the module that drives OVER a FLOWER's
                  // lower ring plate (`BB_FLOWER_RETRIEVE_Z[0]`, the rim the retrieval window
                  // starts above) — it is what sets `BB_SIDE_ROLLER_PLATE_T`, so a thicker sheet
                  // must fail here rather than silently clip the rim in the picture.
                  check(
                    `${label}/${m.edge}: the bottom strap still clears a FLOWER's lower ring rim`,
                    be.zMin > BB_FLOWER_RETRIEVE_Z[0] + 1e-9,
                    `${be.zMin.toFixed(4)} vs rim ${BB_FLOWER_RETRIEVE_Z[0]}`,
                  );
                }
                // ── THE OPEN WORKING ARC, measured off the built meshes' OWN VERTICES rather
                // than from the constants: every bracket triangle is projected into the wheel's
                // own polar frame and the tread is swept in 1° steps; an angle is OCCLUDED when
                // some bracket vertex lies within the tread's radius there, at the wheel's own
                // height band. The boss is inside `BB_SIDE_ROLLER_HUB_R` and is not tread, so the
                // sweep only asks about radii the tread actually occupies.
                for (const side of ['l', 'r'] as const) {
                  const sgn = side === 'l' ? 1 : -1;
                  const cU = f.depth + BB_SIDE_ROLLER_OUT;
                  const cV = sgn * bbSideRollerY(f.half);
                  let worst = 180;
                  for (const nm of names) {
                    const node = group.getObjectByName(nm);
                    if (!node) continue;
                    const pts = mouthPoints(node, f);
                    for (const p of pts) {
                      if (p.z < BB_SIDE_ROLLER_REACH.z[0] - 1e-6 || p.z > BB_SIDE_ROLLER_REACH.z[1] + 1e-6) continue;
                      const du = p.u - cU;
                      const dv = p.v - cV;
                      const rad = Math.hypot(du, dv);
                      // only tread radii matter — a vertex inside the hub cannot hide the tread
                      if (rad < BB_SIDE_ROLLER_HUB_R || rad > BB_SIDE_ROLLER_R + 1e-6) continue;
                      // the angle off the mouth's OUTWARD direction, mirrored so both wheels read
                      // the same way
                      const ang = (Math.atan2(sgn * dv, du) * 180) / Math.PI;
                      worst = Math.min(worst, Math.abs(ang));
                    }
                  }
                  check(
                    `${label}/${m.edge}/${side}: the wheel's forward working arc is open (>= ${MIN_OPEN_ARC} deg of tread, full height)`,
                    2 * worst >= MIN_OPEN_ARC,
                    `open ${(2 * worst).toFixed(1)} deg (first occlusion at ${worst.toFixed(1)} deg off outward)`,
                  );
                }
              }

              // the yoke's own y is `config.ts`'s `bbSideRollerYokeY`, so the 2D sprite can place
              // it without importing the scene chunk — it must be the ARM RAIL's own centreline,
              // which only this file knows. Same dup-guard pattern as `BB_INTAKE_ARM_INSET_DUP`.
              {
                const f = bbMouthFrame(mouths[0], hl, hw);
                const armY = f.half - BB_INTAKE_ARM_INSET - INTAKE_RAIL_T / 2;
                check(
                  `${label}: bbSideRollerYokeY is the side arm rail's own centreline`,
                  Math.abs(bbSideRollerYokeY(f.half) - armY) < 1e-9,
                  `${bbSideRollerYokeY(f.half).toFixed(6)} vs ${armY.toFixed(6)}`,
                );
              }
            }

            if (kind === 'ramp') {
              check(
                `${label}: one pivot per mouth`,
                built.rampPivots.length === mouths.length,
                `${built.rampPivots.length} vs ${mouths.length}`,
              );
              for (const m of mouths) {
                const f = bbMouthFrame(m, hl, hw);
                const pivot = group.getObjectByName(`robot:ramp:${m.edge}`);
                const bar = group.getObjectByName(`robot:ramp:bar:${m.edge}`);
                const railL = group.getObjectByName(`robot:ramp:rail:${m.edge}:l`);
                const railR = group.getObjectByName(`robot:ramp:rail:${m.edge}:r`);
                const roller = group.getObjectByName(`robot:sweeper:${m.edge}`);
                if (!pivot || !bar || !railL || !railR || !roller) {
                  check(`${label}/${m.edge}: every ramp node exists`, false, `pivot=${!!pivot} bar=${!!bar} rails=${!!railL}/${!!railR} roller=${!!roller}`);
                  continue;
                }
                group.updateMatrixWorld(true);

                // ── FOLDED (the built default: `pivot.rotation.y` starts at 0) ──────────────
                const barFolded = mouthExtent(bar, f);
                check(
                  `${label}/${m.edge}: folded, the crossbar top clears the flap sweep`,
                  barFolded.zMax > rollerZ + flapR,
                  `${barFolded.zMax.toFixed(3)} vs sweep top ${(rollerZ + flapR).toFixed(3)}`,
                );
                /**
                 * ⚠️ **THE FOLDED U HAS TO HAVE A HOLE IN IT, AND THE HOLE IS THE ROLLER'S**
                 * (owner: *"when deployed, from the top down, it should look like an upside down
                 * U shape. This is because the hole created by the U is where the intake rollers
                 * are situated in when the ramp is folded up vertically."*). The ramp pivots ON
                 * THE ROLLER'S OWN SHAFT (owner, 2026-09-21: "the ramp collides with the intake
                 * rollers when it is folded up" — the pivot used to hang 2.3 in under the axle, so
                 * a folded rail stood across the shaft where it runs into its bearing). So the
                 * rails' eyes ARE the bearing, they stand outboard of the barrel's ends (checked
                 * below), and the BLADE keeps one fixed distance from the axle at every swing
                 * angle — which has to clear the whole r-2.0 FLAP SWEEP, not just the hub.
                 *
                 * Measured off the blade's OWN VERTICES rather than a Box3, in the roller's own
                 * (u, z) plane, because a Box3 of a diagonal blade is mostly air.
                 */
                {
                  const axisU = f.depth - BB_RAMP_PIVOT_BACK;
                  const axisZ = rollerZ;
                  const v3f = new THREE.Vector3();
                  let minHub = Infinity;
                  let bladeRailLo = Infinity;
                  let worst = '';
                  const sweepR = num('BB_ROLLER_FLAP_R');
                  check(
                    `${label}/${m.edge}: the ramp pivots on the roller's own shaft — BB_RAMP_PIVOT_Z is the roller's axis height`,
                    Math.abs(BB_RAMP_PIVOT_Z - rollerZ) < 1e-9,
                    `${BB_RAMP_PIVOT_Z} vs ${rollerZ}`,
                  );
                  for (const node of [bar]) {
                    node.traverse((o) => {
                      const mesh = o as THREE.Mesh;
                      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
                      if (!geo?.attributes?.position) return;
                      const pos = geo.attributes.position as THREE.BufferAttribute;
                      for (let i = 0; i < pos.count; i++) {
                        v3f.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
                        const du = (v3f.x - f.ox) * Math.cos(f.rot) + (v3f.y - f.oy) * Math.sin(f.rot) - axisU;
                        const dz = v3f.z - axisZ;
                        const gap = Math.sqrt(du * du + dz * dz) - sweepR;
                        if (gap < minHub) {
                          minHub = gap;
                          worst = o.name || node.name;
                        }
                        if (node === bar) bladeRailLo = Math.min(bladeRailLo, v3f.z - BB_RAMP_PIVOT_Z);
                      }
                    });
                  }
                  check(
                    `${label}/${m.edge}: folded, the blade clears the roller's whole FLAP SWEEP (>= 0.1 in)`,
                    Number.isFinite(sweepR) && minHub >= 0.1,
                    `closest ${minHub.toFixed(3)} in on ${worst}`,
                  );
                  // ...and the BLADE, which is the U's own bight, starts OUTBOARD of the hub along
                  // the rail — the difference between "the hub is in the opening" and "the hub is
                  // merely beside the blade", which is what `BB_RAMP_IN` 0.15 was.
                  const hubTopRail = rollerZ - BB_RAMP_PIVOT_Z + hubR;
                  check(
                    `${label}/${m.edge}: folded, the blade's inboard edge lies outboard of the hub along the rail`,
                    bladeRailLo >= hubTopRail + 0.1,
                    `blade starts ${bladeRailLo.toFixed(3)} up the rail, hub top ${hubTopRail.toFixed(3)}`,
                  );
                }

                // MOUTH-LOCAL (u, v, z), not world Box3: a `back`/`right` mouth is itself
                // rotated (`f.rot`), which flips which WORLD side "l" lands on — `mouthExtent`
                // undoes that rotation, so "l" reads as the +v side on every edge.
                const rollerExt = mouthExtent(roller, f);
                const railLExt = mouthExtent(railL, f);
                const railRExt = mouthExtent(railR, f);
                check(
                  `${label}/${m.edge}: the rails clear the (shortened) barrel, one each side`,
                  railLExt.vMin >= rollerExt.vMax - 1e-6 && railRExt.vMax <= rollerExt.vMin + 1e-6,
                  `barrel v [${rollerExt.vMin.toFixed(3)}, ${rollerExt.vMax.toFixed(3)}], rails v [${railRExt.vMax.toFixed(3)}, ${railLExt.vMin.toFixed(3)}]`,
                );

                // ── DEPLOYED — posed by hand, off the SAME angle `config.ts` derives its own
                // reach from, so this measures the BUILT geometry against that derivation
                // rather than re-deriving it a second time. A specific REFERENCE POINT, not a
                // bounding-box extreme: the crossbar box has its own thickness, so its axis-
                // aligned corners are not the rail-tip centreline once the pivot is rotated.
                pivot.rotation.y = Math.PI / 2 + BB_RAMP_ANGLE;
                group.updateMatrixWorld(true);
                const tipWorld = new THREE.Vector3(0, 0, BB_RAMP_L).applyMatrix4(pivot.matrixWorld);
                const dxTip = tipWorld.x - f.ox;
                const dyTip = tipWorld.y - f.oy;
                const tipU = dxTip * Math.cos(f.rot) + dyTip * Math.sin(f.rot);
                check(
                  `${label}/${m.edge}: deployed, the rail tip (and the crossbar's outer face) lands at (tip + BB_RAMP_OUT, BB_RAMP_TIP_Z)`,
                  Math.abs(tipU - (f.depth + BB_RAMP_OUT)) < 1e-3 && Math.abs(tipWorld.z - BB_RAMP_TIP_Z) < 1e-3,
                  `u ${tipU.toFixed(4)} vs ${(f.depth + BB_RAMP_OUT).toFixed(4)}, z ${tipWorld.z.toFixed(4)} vs ${BB_RAMP_TIP_Z.toFixed(4)}`,
                );
                const baseWorld = new THREE.Vector3(0, 0, 0).applyMatrix4(pivot.matrixWorld);
                const dxBase = baseWorld.x - f.ox;
                const dyBase = baseWorld.y - f.oy;
                const baseU = dxBase * Math.cos(f.rot) + dyBase * Math.sin(f.rot);
                const railAngle = Math.atan2(tipWorld.z - baseWorld.z, tipU - baseU);
                check(
                  `${label}/${m.edge}: deployed, the rails lie BB_RAMP_ANGLE below level`,
                  Math.abs(railAngle + BB_RAMP_ANGLE) < 1e-6,
                  `${railAngle.toFixed(6)} rad vs ${(-BB_RAMP_ANGLE).toFixed(6)}`,
                );

                // ── THE BLADE PROFILE — the drawn LIP and the drawn INBOARD END must land on
                // `config.ts`'s own numbers to 1e-3, and the blade's UNDERSIDE on
                // `BB_RAMP_FLOOR_Z`, which is the number that has to clear the FLOWER's lower ring
                // plate (see that constant's own header). The reference points are the box's own
                // local ±half-length along its long axis — a point only the box's centreline
                // reaches — rather than a Box3 extreme padded by its thickness.
                const blade = group.getObjectByName(`robot:ramp:bar:${m.edge}:deck`);
                if (!blade) {
                  check(`${label}/${m.edge}: the ramp's blade exists`, false, 'no robot:ramp:bar:*:deck');
                } else {
                  const uz = (o: THREE.Object3D, localX: number, localZ: number): { u: number; z: number } => {
                    const p = new THREE.Vector3(localX, 0, localZ).applyMatrix4(o.matrixWorld);
                    const dx = p.x - f.ox;
                    const dy = p.y - f.oy;
                    return { u: dx * Math.cos(f.rot) + dy * Math.sin(f.rot), z: p.z };
                  };
                  const len = BB_RAMP_OUT - BB_RAMP_IN;
                  const lip = uz(blade, len / 2, BB_RAMP_WEDGE_THICK);
                  const inner = uz(blade, -len / 2, BB_RAMP_WEDGE_THICK);
                  const under = uz(blade, len / 2, -BB_RAMP_WEDGE_THICK);
                  const wantLip = { u: f.depth + BB_RAMP_OUT, z: BB_RAMP_DECK_Z };
                  const wantIn = { u: f.depth + BB_RAMP_IN, z: BB_RAMP_DECK_Z };
                  const wantUnder = { u: f.depth + BB_RAMP_OUT, z: BB_RAMP_FLOOR_Z };
                  const near = (a: { u: number; z: number }, b: { u: number; z: number }): boolean => Math.abs(a.u - b.u) < 1e-3 && Math.abs(a.z - b.z) < 1e-3;
                  check(
                    `${label}/${m.edge}: the drawn blade's LIP lands on config's own (BB_RAMP_OUT, BB_RAMP_DECK_Z)`,
                    near(lip, wantLip),
                    `(${lip.u.toFixed(4)}, ${lip.z.toFixed(4)}) vs (${wantLip.u.toFixed(4)}, ${wantLip.z.toFixed(4)})`,
                  );
                  check(
                    `${label}/${m.edge}: the drawn blade's INBOARD END lands on config's own (BB_RAMP_IN, BB_RAMP_DECK_Z)`,
                    near(inner, wantIn),
                    `(${inner.u.toFixed(4)}, ${inner.z.toFixed(4)}) vs (${wantIn.u.toFixed(4)}, ${wantIn.z.toFixed(4)})`,
                  );
                  check(
                    `${label}/${m.edge}: the drawn blade's UNDERSIDE is BB_RAMP_FLOOR_Z, clear of the FLOWER's 0.354 plate`,
                    near(under, wantUnder) && BB_RAMP_FLOOR_Z > 0.354,
                    `(${under.u.toFixed(4)}, ${under.z.toFixed(4)}) vs (${wantUnder.u.toFixed(4)}, ${wantUnder.z.toFixed(4)})`,
                  );
                }
                pivot.rotation.y = 0; // leave it as `buildIntake` built it
              }
            }
          }
        }

        // ── THE EASE — the same smoothstep the Box Tube uses, wired the same way (`bbRampAt` /
        // `world.time`, clamped to [0, 1]) and re-derived standalone here (the RENDER lane has no
        // `World` to run `sync` against — see the file header). At t0 the robot is still FOLDED
        // (frac 0); a `BB_RAMP_DEPLOY_S` later it is fully DEPLOYED (frac 1).
        check(
          'the sync code eases the ramp off `bbRampAt`/`world.time`, clamped and smoothstepped',
          robotsCode.includes('r.bbRampAt ?? -Infinity') &&
            robotsCode.includes('BB_RAMP_DEPLOY_S') &&
            robotsCode.includes('smoothstep01(t)'),
        );
        check(
          'the side rollers spin off the SAME running gate as the sweeper, opposite senses',
          robotsCode.includes('sr.phase += BB_ROLLER_SPIN * dt * sr.sign;'),
        );
        {
          const ease = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - c * 2); };
          const deployedAngle = Math.PI / 2 + BB_RAMP_ANGLE;
          const poseAt = (raw: number, out: boolean) => {
            const frac = ease(raw);
            return out ? deployedAngle * frac : deployedAngle * (1 - frac);
          };
          check(
            'ease: at t0 (deploying) the pose is FOLDED',
            Math.abs(poseAt(0, true) - 0) < 1e-9,
          );
          check(
            'ease: a BB_RAMP_DEPLOY_S later (deploying) the pose is DEPLOYED',
            Math.abs(poseAt(1, true) - deployedAngle) < 1e-9,
          );
          check(
            'ease: at t0 (retracting) the pose is still DEPLOYED, and a BB_RAMP_DEPLOY_S later it is FOLDED',
            Math.abs(poseAt(0, false) - deployedAngle) < 1e-9 && Math.abs(poseAt(1, false) - 0) < 1e-9,
          );
          check(
            'BB_RAMP_DEPLOY_S is a positive, finite window (else the ease divides by zero or never arrives)',
            Number.isFinite(BB_RAMP_DEPLOY_S) && BB_RAMP_DEPLOY_S > 0,
            `${BB_RAMP_DEPLOY_S}s`,
          );
        }

        // ── THE 2D SPRITE: same archetypes, drawn OUTSIDE the footprint clip (`drawRobot.ts`'s
        // header on `drawBiobuzzIntakeReach`). Behavioural, not a string match — the calls ARE
        // the behaviour, same as the shot path above.
        interface ReachOp { op: string }
        const reachOps = (kind: (typeof BB_INTAKE_KINDS)[number]): ReachOp[] => {
          const ops: ReachOp[] = [];
          const rec = (op: string) => () => { ops.push({ op }); };
          const ctx = {
            save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
            moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), fill: rec('fill'),
            arc: rec('arc'), closePath: rec('closePath'), translate: rec('translate'), rotate: rec('rotate'),
            set strokeStyle(_v: string) {}, set fillStyle(_v: string) {}, set lineWidth(_v: number) {},
          } as unknown as CanvasRenderingContext2D;
          const spec = mk({ bbMech: { intake: { kind } } } as Partial<RobotSpec>);
          const r = { spec, bbRampOut: false } as unknown as RobotState;
          drawBiobuzzIntakeReach(ctx, r, false, undefined);
          return ops;
        };
        check(
          '2D: the sweeper kind draws NOTHING extra past the footprint (byte-identical sprite)',
          reachOps('sweeper').length === 0,
        );
        check('2D: the siderollers kind draws its wheels', reachOps('siderollers').length > 0);
        // ⚠️ the sprite draws the REAR YOKE too (owner, 2026-09-21, rejecting the housed draft:
        // "It cant be covered fully because it needs to actually touch the balls") — the plan
        // view of the same diagonal strap + bearing boss `scene/renderRobots.ts` builds, with the
        // WHEEL drawn last so nothing is ever over its tread. One CLOSED, FILLED quad per wheel.
        {
          const ops = reachOps('siderollers').map((o) => o.op);
          const spec2d = mk({ bbMech: { intake: { kind: 'siderollers' } } } as Partial<RobotSpec>);
          const wheels = bbMouths(spec2d).length * 2;
          check(
            '2D: and it draws each wheel a rear YOKE, closed and filled, not a bracket line',
            ops.filter((o) => o === 'closePath').length === wheels,
            `${wheels} wheels: ${ops.filter((o) => o === 'closePath').length} closed paths`,
          );
          // ...and the OUTLINE's own numbers, not just its shape of calls.
          {
            const pts: { x: number; y: number }[] = [];
            const arcs: { x: number; y: number; r: number; a0: number; a1: number; ccw: boolean }[] = [];
            const xy = (x: number, y: number) => { pts.push({ x, y }); };
            const ctx2 = {
              save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, closePath() {},
              translate() {}, rotate() {}, moveTo: xy, lineTo: xy,
              arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) { arcs.push({ x, y, r, a0, a1, ccw }); },
              set strokeStyle(_v: string) {}, set fillStyle(_v: string) {}, set lineWidth(_v: number) {},
            } as unknown as CanvasRenderingContext2D;
            drawBiobuzzIntakeReach(ctx2, { spec: spec2d, bbRampOut: false } as unknown as RobotState, false, undefined);
            const m0 = bbMouths(spec2d)[0];
            const f0 = bbMouthFrame(m0, spec2d.length / 2, spec2d.width / 2);
            const front = f0.depth + BB_SIDE_ROLLER_PROTRUDE;
            const axleX = f0.depth + BB_SIDE_ROLLER_OUT;
            check(
              "2D: no point of the drawn module reaches past the wheel's own solid front",
              pts.every((p) => p.x <= front + 1e-9) && arcs.every((a) => a.x + a.r <= front + 1e-9),
              `front=${front.toFixed(4)} maxPt=${Math.max(...pts.map((p) => p.x)).toFixed(4)} maxArc=${Math.max(...arcs.map((a) => a.x + a.r)).toFixed(4)}`,
            );
            // ⚠️ THE BRACKET MAY NOT BE DRAWN OVER THE TREAD. Every straight segment the sprite
            // emits belongs to the yoke strap or to a tread LUG; the strap's own points may not
            // pass the axle line at all, and the only circles are the BOSS, the TREAD and the HUB
            // — there is no cap on the wheel's own radius any more, which is precisely what the
            // owner rejected. A lug's inner end sits on the hub, so a lug point is recognised by
            // being inside the tread's own radius of a wheel axis.
            const wheelYs = [bbSideRollerY(f0.half), -bbSideRollerY(f0.half)];
            const onWheel = (p: { x: number; y: number }): boolean =>
              wheelYs.some((wy) => Math.hypot(p.x - axleX, p.y - wy) <= BB_SIDE_ROLLER_R + 1e-9);
            const strapPts = pts.filter((p) => !onWheel(p));
            check(
              '2D: the yoke strap stops at the axle line and is never drawn over the tread',
              strapPts.length > 0 && strapPts.every((p) => p.x <= axleX + 1e-9),
              `${strapPts.length} strap points, max x ${Math.max(...strapPts.map((p) => p.x)).toFixed(4)} vs axle ${axleX.toFixed(4)}`,
            );
            const radii = [...new Set(arcs.map((a) => Number(a.r.toFixed(6))))].sort((a, b) => a - b);
            check(
              '2D: the only circles are the BOSS, the HUB and the TREAD — nothing caps the wheel',
              radii.length === 3 &&
                Math.abs(radii[0] - BB_SIDE_ROLLER_BOSS_R) < 1e-6 &&
                Math.abs(radii[1] - BB_SIDE_ROLLER_HUB_R) < 1e-6 &&
                Math.abs(radii[2] - BB_SIDE_ROLLER_R) < 1e-6,
              `radii ${radii.join(', ')}`,
            );
            // and the TREAD is drawn AFTER the bracket, so a viewer never sees the bracket on top
            const firstTread = arcs.findIndex((a) => Math.abs(a.r - BB_SIDE_ROLLER_R) < 1e-6);
            const firstBoss = arcs.findIndex((a) => Math.abs(a.r - BB_SIDE_ROLLER_BOSS_R) < 1e-6);
            check(
              '2D: the tread is drawn after its own yoke boss, never under it',
              firstTread > firstBoss && firstBoss >= 0,
              `tread at ${firstTread}, boss at ${firstBoss}`,
            );
          }
        }
        check('2D: the ramp kind draws its rest-pose outline', reachOps('ramp').length > 0);
      }

      // ── THE BOX TUBE (owner, 2026-09-22: "Offset boxtube still looks extremely weird") ────────
      //
      // `config.ts`'s "THE BOX TUBE" block has the design and the five things the telescoping arm
      // got wrong. The one this lane has to answer for is the first: the old sweep checked the
      // tip of an UNCAPPED solve while the renderer drew a capped one, so a robot flush on a
      // FLOWER — the pose every placement is made from — showed a stub at 19% and the lane stayed
      // green. Everything below is measured off the BUILT tube (`buildBoxTube`, no DOM), posed
      // through the renderer's own `poseBoxTubeRig`, and never off a second derivation of it.
      {
        check(
          'box tube: the 3D tower is built from the SHARED frame and the sim’s own placement point',
          robotsCode.includes('const place = bbPlacePointLocal(spec);') &&
            robotsCode.includes('const frame = bbBoxTubeFrame(spec, mount, place);') &&
            robotsCode.includes('node.rotation.z = Math.atan2(frame.uy, frame.ux);'),
        );
        check(
          'box tube: the renderer names no box-tube constant of its own (they are hardware, in config.ts)',
          !/const BB_BOX_TUBE_[A-Z_]+ =/.test(robotsCode) && robotsCode.includes('BB_BOX_TUBE_SECTIONS'),
        );
        check('box tube: the tubes are HOLLOW — a tube, not a bar', /const wall = BB_BOX_TUBE_WALL;/.test(robotsCode));
        check(
          'box tube: THREE nested tubes, the OFFSET™ kit’s "2-stage" slide — not a five-piece antenna',
          BB_BOX_TUBE_SECTIONS.length === 3 &&
            BB_BOX_TUBE_SECTIONS.every((w, i) => i === 0 || Math.abs(BB_BOX_TUBE_SECTIONS[i - 1] - 2 * BB_BOX_TUBE_WALL - w) < 1e-9),
          BB_BOX_TUBE_SECTIONS.join(' / '),
        );
        check(
          'box tube: the WHOLE slide leans — every tube hangs off the pitch node, each nested in the one outboard of it',
          robotsCode.includes('(i === 0 ? pitch : stages[i - 1]).add(mesh);') && !robotsCode.includes('(i === 0 ? node : pitch)'),
        );
        check(
          'box tube: it deploys off the sim’s reach predicate, on the WORLD clock, and writes nothing back',
          robotsCode.includes('const flower = bbFlowerInReach(world, r);') &&
            robotsCode.includes('dt / BB_BOX_TUBE_EXTEND_S') &&
            robotsCode.includes('const dt = Math.max(0, Math.min(0.2, world.time - lastTime));') &&
            !/r\.(bbTube|tubeEase)/.test(robotsCode),
        );
        check(
          'box tube: the deploy takes 0.35–0.5 s and the retraction a fraction of it — neither the 0.12 "violent" nor a crawl',
          BB_BOX_TUBE_EXTEND_S >= 0.35 && BB_BOX_TUBE_EXTEND_S <= 0.5 && BB_BOX_TUBE_RETRACT_F >= 0.5 && BB_BOX_TUBE_RETRACT_F <= 1 &&
            robotsCode.includes('step / BB_BOX_TUBE_RETRACT_F'),
          `${BB_BOX_TUBE_EXTEND_S} s out, ${(BB_BOX_TUBE_EXTEND_S * BB_BOX_TUBE_RETRACT_F).toFixed(2)} s back`,
        );
        check(
          'box tube: a change of target SLEWS once the arm is out, and a stowed arm takes its first target whole',
          /entry\.tubeLean \+= clampAbs\(pose\.lean - entry\.tubeLean, slew\);/.test(robotsCode) &&
            /entry\.tubePsi \+= clampAbs\(wrapPi\(pose\.psi - entry\.tubePsi\), slew\);/.test(robotsCode) &&
            /if \(entry\.tubeEase <= 0\) \{/.test(robotsCode),
        );
        // THE SEQUENCE: each joint starts and stops at zero rate, and the claw moves only once the
        // slide is out and only turns over the bore once it is level — the order the sweep below
        // found is the only one that clears the flower
        {
          let order = true;
          let ends = true;
          for (let i = 0; i <= 1000; i++) {
            const q = bbBoxTubePhases(i / 1000);
            if (q.swing > 0 && q.extend < 1) order = false;
            if (q.reach > 0 && q.swing < 1) order = false;
          }
          const q0 = bbBoxTubePhases(0);
          const q1 = bbBoxTubePhases(1);
          for (const k of ['lean', 'turn', 'extend', 'swing', 'reach'] as const) {
            if (q0[k] !== 0 || q1[k] !== 1) ends = false;
            const d0 = bbBoxTubePhases(1e-4)[k] - q0[k];
            const d1 = q1[k] - bbBoxTubePhases(1 - 1e-4)[k];
            if (d0 > 1e-3 || d1 > 1e-3) ends = false;
          }
          check('box tube: every phase runs 0 → 1 and leaves and arrives at zero rate', ends);
          check('box tube: the claw swings only once the slide is fully out, and turns in only once it is level', order);
        }

        const mounts = ['front', 'back', 'left', 'right', 'frontleft', 'frontright', 'backleft', 'backright'] as const;
        const sizes = [[13.5, 13.5], [18, 18], [17.5, 13.5], [15, 17]] as const;
        const mkLift = (L: number, W: number, mount: string, intakeMount: string, turret = 'center'): RobotSpec =>
          bbCoerceSpec({
            ...BB_DEFAULT_SPEC,
            length: L,
            width: W,
            bbMech: { launcher: { kind: 'turret', mount: turret, hoodDeg: 75 }, lift: { kind: 'vslide', mount }, intake: { kind: 'sweeper' } },
            intakeMount,
          } as unknown as RobotSpec);
        /** every vertex of every mesh under `root`, in `root`'s parent frame */
        const verts = (root: THREE.Object3D, pick: (m: THREE.Mesh) => boolean = () => true): THREE.Vector3[] => {
          root.updateMatrixWorld(true);
          const out: THREE.Vector3[] = [];
          root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || !pick(m)) return;
            const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
          });
          return out;
        };

        // ---- THE STOWED TOWER, per build: in the frame, on the deck, inside its collider, out of
        // the centre turret's way, and under the shortest legal robot
        {
          let placeBad = '';
          let outFrame = '';
          let belowDeck = '';
          let outCollider = '';
          let topBad = '';
          let turretWorst = Infinity;
          let detached = '';
          let stowTop = 0;
          let builds = 0;
          for (const mount of mounts) {
            for (const intakeMount of ['front', 'side', 'frontback', 'back'] as const) {
              for (const [L, W] of sizes) {
                const spec = mkLift(L, W, mount, intakeMount);
                const lift = bbLiftOf(spec);
                const place = bbPlacePointLocal(spec);
                if (!lift || !place) continue;
                builds++;
                const copy = bbLiftPlaceLocal(spec);
                if (!copy || Math.abs(copy.x - place.x) > 1e-12 || Math.abs(copy.y - place.y) > 1e-12) placeBad ||= `${mount}/${intakeMount}/${L}x${W}`;
                const tube = buildBoxTube(spec, lift.mount, 9);
                const vs = verts(tube.node);
                const edgeMount = ['front', 'back', 'left', 'right'].includes(lift.mount);
                // the COERCED chassis, not the asked-for one: a lift and a turret can widen it
                const hl = spec.length / 2;
                const hw = spec.width / 2;
                const shapes = chassis3dShapes(spec, BB3_HEIGHT_MIN);
                const inShape = (v: THREE.Vector3): boolean =>
                  shapes.some((s) => {
                    const z = v.z - BB3_HEIGHT_MIN / 2;
                    if (Math.abs(z - s.cz) > s.hz + 1e-6) return false;
                    if (s.shape === 'cylinder') return Math.hypot(v.x - s.cx, v.y - s.cy) <= s.hx + 1e-6;
                    return Math.abs(v.x - s.cx) <= s.hx + 1e-6 && Math.abs(v.y - s.cy) <= s.hy + 1e-6;
                  });
                let top = 0;
                for (const v of vs) {
                  top = Math.max(top, v.z);
                  if (Math.abs(v.x) > hl + 1e-6 || Math.abs(v.y) > hw + 1e-6) outFrame ||= `${mount}/${intakeMount}/${L}x${W} (${v.x.toFixed(2)}, ${v.y.toFixed(2)})`;
                  // the pivot belt alone runs 0.05 in down into its slot in the deck
                  if (v.z < BB_DECK_Z - 0.051) belowDeck ||= `${mount}/${intakeMount} z ${v.z.toFixed(3)}`;
                  if (!inShape(v)) outCollider ||= `${mount}/${intakeMount}/${L}x${W} (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
                  // the centre turret's head sweeps a disc above its ring; an EDGE-mounted tower, the
                  // one that shares the rail's middle with it, stays out of that disc
                  if (edgeMount && v.z > BB_DECK_Z + 0.55) turretWorst = Math.min(turretWorst, Math.hypot(v.x, v.y) - BB3_TURRET_R);
                }
                stowTop = Math.max(stowTop, top);
                // ATTACHED: the pivot plates stand ON the deck, and the axle they carry runs through
                // the base tube's own foot — the tower is bolted to the robot, not floating over it
                {
                  const pivot = tube.node.getObjectByName('robot:9:tube:pivot') as THREE.Mesh;
                  const s0 = tube.stages[0] as THREE.Mesh;
                  const pb = new THREE.Box3().setFromBufferAttribute(pivot.geometry.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(pivot.matrixWorld);
                  s0.geometry.computeBoundingBox();
                  const sb = s0.geometry.boundingBox!.clone().applyMatrix4(s0.matrixWorld);
                  if (Math.abs(pb.min.z - BB_DECK_Z) > 1e-6 || !(sb.min.z < BB_BOX_TUBE_Z && sb.max.z > BB_BOX_TUBE_Z) || sb.min.z <= BB_DECK_Z) {
                    detached ||= `${mount}/${intakeMount}/${L}x${W}: plates from z ${pb.min.z.toFixed(3)}, base tube ${sb.min.z.toFixed(3)}…${sb.max.z.toFixed(3)}, axle ${BB_BOX_TUBE_Z}`;
                  }
                }
                const liftTop = Math.max(...bbMechEnvelopes(spec, 29).filter((e) => e.what === 'liftColumn').map((e) => e.top));
                if (Math.abs(liftTop - top) > 1e-6 || top > BB3_HEIGHT_MIN) topBad ||= `${mount}/${intakeMount}/${L}x${W}: drawn ${top.toFixed(3)} collider ${liftTop.toFixed(3)}`;
                disposeRobotGroup(tube.node);
              }
            }
          }
          check('box tube: the renderer’s placement point and the collider’s are one number on every build', placeBad === '' && builds > 100, placeBad || `${builds} builds`);
          check('box tube: STOWED, every part is inside the frame rail — R101’s starting cube', outFrame === '', outFrame);
          check('box tube: nothing hangs below the deck (only the pivot belt, into its slot)', belowDeck === '', belowDeck);
          check('box tube: the tower is ATTACHED — its pivot plates stand on the deck and their axle runs through the base tube’s foot', detached === '', detached);
          check('box tube: every drawn vertex of the stowed tower is inside the chassis compound — no part of it is a ghost', outCollider === '', outCollider);
          check(
            'box tube: the tower’s collider stops at its drawn top, and that top fits under the shortest legal robot',
            topBad === '',
            topBad || `drawn top ≤ ${stowTop.toFixed(3)} in vs ${BB3_HEIGHT_MIN}`,
          );
          check(
            'box tube: the stowed tower stays out of a centre turret’s swept disc — the old cradle ran 2.3 in into its ring',
            turretWorst > 0,
            `nearest ${turretWorst.toFixed(3)} in outside ${BB3_TURRET_R}`,
          );
        }

        // ---- 2D = 3D: the sprite and the builder schematic fill the boxes the 3D base is built from
        {
          const drawSrc = codeLines(join(BIOBUZZ_DIR, 'drawRobot.ts')).join('\n');
          const previewSrc = codeLines(join(BIOBUZZ_DIR, 'RobotPreview.tsx')).join('\n');
          check(
            'box tube 2D: the sprite and the builder draw the stowed tower from the shared boxes, and pose it with the shared solve',
            /for \(const b of g\.boxes\)/.test(drawSrc) && /bbBoxTubePose\(/.test(drawSrc) && /g\.boxes/.test(previewSrc),
          );
          let worst = 0;
          for (const mount of mounts) {
            const spec = mkLift(15, 17, mount, 'front');
            const lift = bbLiftOf(spec)!;
            const place = bbPlacePointLocal(spec);
            const g = bbBoxTubeGlyph(spec, lift.mount, place);
            const tube = buildBoxTube(spec, lift.mount, 9);
            tube.node.updateMatrixWorld(true);
            const s0 = tube.stages[0] as THREE.Mesh;
            s0.geometry.computeBoundingBox();
            const bb = s0.geometry.boundingBox!.clone().applyMatrix4(s0.matrixWorld);
            const h0 = BB_BOX_TUBE_SECTIONS[0] / 2;
            const mast = bbTowerBoxRobot(g.frame, { what: 'mast', u0: -h0, u1: h0, v0: -h0, v1: h0, z0: 0, z1: 0 });
            worst = Math.max(worst, Math.abs(bb.min.x - mast.x0), Math.abs(bb.max.x - mast.x1), Math.abs(bb.min.y - mast.y0), Math.abs(bb.max.y - mast.y1));
            disposeRobotGroup(tube.node);
          }
          check('box tube 2D = 3D: the base tube the sprite fills is the base tube the scene builds', worst < 1e-6, `worst ${worst.toExponential(2)} in`);
        }

        // ---- THE END BAR GIVES WAY for a tube on its rail, rather than burying the pivot
        {
          const spec = mkLift(15, 17, 'back', 'front');
          const m = bbFrontMarks(spec);
          const bars = buildFrontMarks(spec, 9).find((n) => n.name === 'robot:9:rear:bar')!;
          const g = bbBoxTubeGlyph(spec, 'back', bbPlacePointLocal(spec));
          const base = g.boxes.filter((b) => b.what !== 'claw').map((b) => bbTowerBoxRobot(g.frame, b));
          const overlap = verts(bars).some((v) => base.some((b) => v.x > b.x0 + 1e-6 && v.x < b.x1 - 1e-6 && v.y > b.y0 + 1e-6 && v.y < b.y1 - 1e-6 && v.z < b.z1));
          check(
            'box tube: a back-mounted tube splits the rear rail round its pivot, and no bar passes through it',
            !!m.rear.gap && bbEndBarSegments(m.rear).length === 2 && !overlap && !bbFrontMarks({ ...spec, bbMech: { ...spec.bbMech!, lift: null } }).rear.gap,
            JSON.stringify(m.rear.gap),
          );
        }

        // ---- THE DEPLOY, against the FLOWER'S REAL SOLID ------------------------------------------
        //
        // The envelope is re-measured off the shipped `field.glb` every run (`flower_0` is F1, whose
        // inward normal is +x, so its local frame is the world one), and it is a HOLLOW column: a ray
        // at (z, azimuth) crosses solid between an inner and an outer radius, and the middle is the
        // bore an element is placed INTO. `clearOf` is the radial distance to that shell, negative
        // inside it; both take the max/min over the neighbouring bins, because a vertex grid
        // under-reads a surface between its own vertices.
        const ENV_DZ = 0.05;
        const ENV_NZ = Math.ceil(24 / ENV_DZ);
        const ENV_NA = 72;
        const env = new Float64Array(ENV_NZ * ENV_NA);
        const envIn = new Float64Array(ENV_NZ * ENV_NA).fill(Infinity);
        let envMax = 0;
        let envVerts = 0;
        {
          const f0 = FIELD_GLB_SCENE?.getObjectByName('flower_0') ?? null;
          if (f0) {
            f0.updateMatrixWorld(true);
            const cx = -68.0447; // F1 top-bore centre, `field-measurements.json`
            const cy = -23.3924;
            const v = new THREE.Vector3();
            f0.traverse((o) => {
              const m = o as THREE.Mesh;
              if (!(m as { isMesh?: boolean }).isMesh) return;
              const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
              for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
                const r = Math.hypot(v.x - cx, v.y - cy);
                let th = Math.atan2(v.y - cy, v.x - cx);
                if (th < 0) th += Math.PI * 2;
                const zi = Math.max(0, Math.min(ENV_NZ - 1, Math.floor(v.z / ENV_DZ)));
                const ai = Math.min(ENV_NA - 1, Math.floor((th / (Math.PI * 2)) * ENV_NA));
                const k = zi * ENV_NA + ai;
                if (r > env[k]) env[k] = r;
                if (r < envIn[k]) envIn[k] = r;
                if (r > envMax) envMax = r;
                envVerts++;
              }
            });
          }
        }
        check(
          'box tube: the flower envelope came off the SHIPPED asset, not a constant (else every check below is vacuous)',
          envVerts > 4000 && envMax > 4,
          `${envVerts} vertices, widest ${envMax.toFixed(3)} in`,
        );
        const envAt = (z: number, th: number): number => {
          if (z < 0 || z >= ENV_NZ * ENV_DZ) return 0;
          const zi = Math.floor(z / ENV_DZ);
          let t = th;
          while (t < 0) t += Math.PI * 2;
          const ai = Math.min(ENV_NA - 1, Math.floor((t / (Math.PI * 2)) * ENV_NA));
          let m = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = zi + dz;
            if (zz < 0 || zz >= ENV_NZ) continue;
            for (let da = -1; da <= 1; da++) {
              const e = env[zz * ENV_NA + ((ai + da + ENV_NA) % ENV_NA)];
              if (e > m) m = e;
            }
          }
          return m;
        };
        const clearOf = (z: number, th: number, rad: number): number => {
          if (z < 0 || z >= ENV_NZ * ENV_DZ) return Infinity;
          const zi = Math.floor(z / ENV_DZ);
          let t = th;
          while (t < 0) t += Math.PI * 2;
          const ai = Math.min(ENV_NA - 1, Math.floor((t / (Math.PI * 2)) * ENV_NA));
          let out = 0;
          let inn = Infinity;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = zi + dz;
            if (zz < 0 || zz >= ENV_NZ) continue;
            for (let da = -1; da <= 1; da++) {
              const k = zz * ENV_NA + ((ai + da + ENV_NA) % ENV_NA);
              if (env[k] > out) out = env[k];
              if (envIn[k] < inn) inn = envIn[k];
            }
          }
          if (out <= 0) return Infinity;
          if (rad >= out) return rad - out;
          if (rad <= inn) return inn - rad;
          return -Math.min(out - rad, rad - inn);
        };
        // the constant the claw reach is sized from has to cover the asset, in the field half
        {
          let worstUnder = 0;
          let atDeg = 0;
          for (let d = 0; d <= 90; d += 1) {
            const th = (d * Math.PI) / 180;
            let measured = 0;
            for (const sign of [1, -1] as const) {
              for (let z = 0; z < BB_FLOWER_TOP_Z; z += ENV_DZ) measured = Math.max(measured, envAt(z, sign * th));
            }
            const under = measured - bbFlowerOuterR(th);
            if (under > worstUnder) {
              worstUnder = under;
              atDeg = d;
            }
          }
          check(
            'box tube: BB_FLOWER_OUTER_R covers the asset it was measured from, at every approach angle',
            worstUnder <= 0.001,
            `worst shortfall ${worstUnder.toFixed(4)} in at ${atDeg}°; table ${BB_FLOWER_OUTER_MIN}…${BB_FLOWER_OUTER_MAX}, bore ${BB_FLOWER_OPEN_R.toFixed(3)}`,
          );
          const topHalf = BB_BOX_TUBE_SECTIONS[BB_BOX_TUBE_SECTIONS.length - 1] / 2;
          check(
            'box tube: the claw reaches far enough that the mast stands clear of the widest top plate',
            BB_BOX_TUBE_CLAW_REACH >= BB_FLOWER_OUTER_MAX + topHalf + BB_BOX_TUBE_FLOWER_GAP,
            `${BB_BOX_TUBE_CLAW_REACH} vs ${BB_FLOWER_OUTER_MAX} + ${topHalf} + ${BB_BOX_TUBE_FLOWER_GAP}`,
          );
        }

        const footRect = (f: (typeof BB_FLOWERS)[number]) => {
          const n = FLOWER_MOUTH[f.wall];
          const wx = f.x - n.x * BB_FLOWER_D;
          const wy = f.y - n.y * BB_FLOWER_D;
          const half = BB_FLOWER_FOOT.along / 2;
          const deep = BB_FLOWER_FOOT.deep / 2;
          return { hx: n.x === 0 ? half : deep, hy: n.y === 0 ? half : deep, cx: wx + n.x * deep, cy: wy + n.y * deep };
        };
        // SAT between the robot's rotated footprint and the axis-aligned foot
        const onFoot = (
          px: number, py: number, hd: number,
          fx: { front: number; rear: number; half: number },
          rect: { hx: number; hy: number; cx: number; cy: number },
        ): boolean => {
          const c = Math.cos(hd);
          const s = Math.sin(hd);
          const cx = px + (c * (fx.front - fx.rear)) / 2;
          const cy = py + (s * (fx.front - fx.rear)) / 2;
          const hl2 = (fx.front + fx.rear) / 2;
          for (const [ax, ay] of [[1, 0], [0, 1], [c, s], [-s, c]] as const) {
            const rA = Math.abs(ax) * rect.hx + Math.abs(ay) * rect.hy;
            const rB = Math.abs(ax * c + ay * s) * hl2 + Math.abs(-ax * s + ay * c) * fx.half;
            if (Math.abs((cx - rect.cx) * ax + (cy - rect.cy) * ay) > rA + rB) return false;
          }
          return true;
        };

        let poses = 0;
        let skippedFoot = 0;
        let clawErr = 0;
        let short = 0;
        let bad = 0;
        let worstPen = 0;
        let worstGap = Infinity;
        let worstWhat = '';
        let gapWhat = '';
        let nearCount = 0;
        let lowest = Infinity;
        let leanLo = Infinity;
        let leanHi = -Infinity;
        const EASES = 20;
        const TUBE_LINES = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]] as const;
        const p = new THREE.Vector3();
        for (const mount of mounts) {
          for (const intakeMount of ['front', 'side', 'frontback'] as const) {
            for (const [L, W] of [[13.5, 13.5], [18, 18], [17.5, 13.5]] as const) {
              const spec = mkLift(L, W, mount, intakeMount);
              const lift = bbLiftOf(spec);
              const place = bbPlacePointLocal(spec);
              if (!lift || !place) continue;
              const tube = buildBoxTube(spec, lift.mount, 9);
              const holder = new THREE.Group();
              holder.add(tube.node);
              const rig = tube.rig;
              const topHalf = BB_BOX_TUBE_SECTIONS[BB_BOX_TUBE_SECTIONS.length - 1] / 2;
              const armLen = BB_BOX_TUBE_CLAW_REACH - BB_BOX_TUBE_WRIST_E - BB_BOX_TUBE_PALM_BACK;
              const world = mkWorld('match', 11, spec);
              const r = world.robots[0];
              const fx = bbFootprint(spec);
              for (let fi = 0; fi < BB_FLOWERS.length; fi++) {
                const f = BB_FLOWERS[fi];
                const rect = footRect(f);
                const nrm = FLOWER_MOUTH[f.wall];
                for (let h = 0; h < 12; h++) {
                  const heading = (h * Math.PI * 2) / 12;
                  const c = Math.cos(heading);
                  const s = Math.sin(heading);
                  const px = place.x * c - place.y * s;
                  const py = place.x * s + place.y * c;
                  for (const off of [0, 0.9, 1.9]) {
                    for (let a = 0; a < 6; a++) {
                      const th = (a * Math.PI * 2) / 6;
                      r.heading = heading;
                      r.pos.x = f.x + Math.cos(th) * off - px;
                      r.pos.y = f.y + Math.sin(th) * off - py;
                      if (bbFlowerInReach(world, r) !== fi) continue;
                      // a pose the FLOWER FOOT or the PERIMETER WALL forbids is not a pose
                      if (onFoot(r.pos.x, r.pos.y, heading, fx, rect)) {
                        skippedFoot++;
                        continue;
                      }
                      {
                        const hl2 = (fx.front + fx.rear) / 2;
                        const cx2 = r.pos.x + (c * (fx.front - fx.rear)) / 2;
                        const cy2 = r.pos.y + (s * (fx.front - fx.rear)) / 2;
                        const ex = Math.abs(c) * hl2 + Math.abs(s) * fx.half;
                        const ey = Math.abs(s) * hl2 + Math.abs(c) * fx.half;
                        if (Math.abs(cx2) + ex > BB_HALF_X || Math.abs(cy2) + ey > BB_HALF_Y) continue;
                      }
                      poses++;
                      holder.position.set(r.pos.x, r.pos.y, 0);
                      holder.rotation.set(0, 0, heading);
                      const dx = f.x - r.pos.x;
                      const dy = f.y - r.pos.y;
                      const pose = bbBoxTubePose(
                        rig.frame,
                        rig.stages,
                        { x: dx * c + dy * s, y: -dx * s + dy * c },
                        { x: nrm.x * c + nrm.y * s, y: -nrm.x * s + nrm.y * c },
                      );
                      leanLo = Math.min(leanLo, pose.lean);
                      leanHi = Math.max(leanHi, pose.lean);
                      // the sizing covered it: no pose asks for more slide than the stages have
                      const want = (Math.hypot(pose.s, BB_FLOWER_TOP_Z + BB_BOX_TUBE_TIP_CLEAR - BB_BOX_TUBE_Z) - rig.stages.retracted) / rig.stages.moving;
                      if (want > rig.stages.travel + 1e-9) short++;
                      let poseWorst = Infinity;
                      let poseWhat = '';
                      let curE = 0;
                      const test = (what: string, half: number): void => {
                        if (p.z < 0) return;
                        const ax2 = p.x - f.x;
                        const ay2 = p.y - f.y;
                        const rad = Math.hypot(ax2, ay2);
                        if (rad - half > envMax) return;
                        const thq = Math.atan2(ax2 * nrm.y - ay2 * nrm.x, ax2 * nrm.x + ay2 * nrm.y);
                        const cl = clearOf(p.z, thq, rad) - half;
                        if (cl < poseWorst) {
                          poseWorst = cl;
                          poseWhat = `${what} at e ${curE.toFixed(2)}, z ${p.z.toFixed(2)}, r ${rad.toFixed(2)}, ${((thq * 180) / Math.PI).toFixed(0)}°`;
                        }
                      };
                      for (let ei = 0; ei <= EASES; ei++) {
                        const e = ei / EASES;
                        curE = e;
                        poseBoxTubeRig(rig, tube.stages, bbBoxTubeJoints(rig.frame, pose, e));
                        holder.updateMatrixWorld(true);
                        // every TUBE, along its four edges and the middles of its four faces — the
                        // drawn box itself, not an axis with a radius round it
                        for (let i = 0; i < tube.stages.length; i++) {
                          const m = tube.stages[i].matrixWorld;
                          const hw2 = BB_BOX_TUBE_SECTIONS[i] / 2;
                          for (const [ex, ey] of TUBE_LINES) {
                            for (let k = 0; k <= 12; k++) {
                              p.set(ex * hw2, ey * hw2, -BB_BOX_TUBE_BASE_BELOW + (k / 12) * rig.stages.sectionLen).applyMatrix4(m);
                              if (k === 0) lowest = Math.min(lowest, p.z);
                              test(`s${i}`, 0);
                            }
                          }
                        }
                        // the wrist block and the yoke, at the 27 points of each box's own grid
                        const box3 = (m: THREE.Matrix4, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, what: string): void => {
                          for (const fx2 of [0, 0.5, 1]) {
                            for (const fy of [0, 0.5, 1]) {
                              for (const fz of [0, 0.5, 1]) {
                                p.set(x0 + (x1 - x0) * fx2, y0 + (y1 - y0) * fy, z0 + (z1 - z0) * fz).applyMatrix4(m);
                                test(what, 0);
                              }
                            }
                          }
                        };
                        const wh = BB_BOX_TUBE_WRIST_HALF;
                        box3(rig.level.matrixWorld, -wh, wh, -wh * 0.8, wh * 0.8, 0, BB_BOX_TUBE_WRIST_TOP, 'wrist');
                        box3(rig.yaw.matrixWorld, wh - 0.25, BB_BOX_TUBE_YOKE_OUT, -BB_BOX_TUBE_CLAW_HALF, BB_BOX_TUBE_CLAW_HALF, BB_BOX_TUBE_WRIST_H - 0.15, BB_BOX_TUBE_WRIST_TOP, 'yoke');
                        for (let k = 0; k <= 8; k++) {
                          p.set(0, 0, -(k / 8) * armLen).applyMatrix4(rig.swing.matrixWorld);
                          test('arm', (Math.hypot(BB_BOX_TUBE_ARM_T, BB_BOX_TUBE_ARM_W)) / 2);
                        }
                        for (const jw of rig.jaws) {
                          for (let k = 0; k <= 6; k++) {
                            p.set(0, 0, -(k / 6) * BB_BOX_TUBE_JAW_L).applyMatrix4(jw.matrixWorld);
                            test('jaw', BB_BOX_TUBE_JAW_H / 2);
                          }
                        }
                        void topHalf;
                        // FULLY OUT, the claw is over the bore — measured on the drawn marker
                        if (ei === EASES) {
                          const claw = tube.node.getObjectByName('robot:9:tube:claw')!;
                          claw.getWorldPosition(p);
                          clawErr = Math.max(clawErr, Math.hypot(p.x - f.x, p.y - f.y), Math.abs(p.z - (BB_FLOWER_TOP_Z + BB_BOX_TUBE_TIP_CLEAR + BB_BOX_TUBE_WRIST_H)));
                        }
                      }
                      if (poseWorst < 0) {
                        bad++;
                        if (-poseWorst > worstPen) {
                          worstPen = -poseWorst;
                          worstWhat = `${mount}/${intakeMount}/${L}x${W} F${fi + 1}: ${poseWhat}`;
                        }
                      } else if (poseWorst < BB_BOX_TUBE_FLOWER_GAP && ++nearCount && poseWorst < worstGap) {
                        worstGap = poseWorst;
                        gapWhat = `${mount}/${intakeMount}/${L}x${W} F${fi + 1}: ${poseWhat}`;
                      }
                    }
                  }
                }
              }
              disposeRobotGroup(tube.node);
            }
          }
        }
        check('box tube deploy sweep: it found in-reach, collision-legal poses to measure at all', poses > 2000 && skippedFoot > 0, `${poses} poses, ${skippedFoot} dropped on a flower foot`);
        check(
          'box tube: FULLY OUT, the drawn claw is over the FLOWER’s bore on every pose — the flush pose included',
          clawErr < 1e-6,
          `worst ${clawErr.toExponential(2)} in over ${poses} poses`,
        );
        check('box tube: ...and no pose asks for more slide than the stages have', short === 0, `${short} poses short`);
        check(
          'box tube: the drawn tower, wrist and claw clear the flower’s real solid at every ease of every pose',
          bad === 0,
          bad ? `${bad}/${poses} meshing, worst ${worstPen.toFixed(3)} in (${worstWhat})` : `0/${poses}`,
        );
        // the tightest pose is a CORNER tube reaching along the wall, whose yoke passes the end of
        // the flower's wall-side backstop (z 22.0–22.65); the mast itself keeps the plate margin
        check(
          '...with clear air, not a tangency that rounds the right way',
          worstGap > 0.02,
          `tightest ${worstGap === Infinity ? 'n/a' : worstGap.toFixed(3)} in (${gapWhat}); ${nearCount} of ${poses} poses under ${BB_BOX_TUBE_FLOWER_GAP}`,
        );
        check(
          'box tube: the slide stands UP — it leans a few degrees, never lies down',
          leanLo > (70 * Math.PI) / 180 && leanHi < (100 * Math.PI) / 180,
          `${((leanLo * 180) / Math.PI).toFixed(1)}° … ${((leanHi * 180) / Math.PI).toFixed(1)}°`,
        );
        check(
          'box tube: no tube dips into the deck at any ease (the old arm’s tails swung 1.6 in into it)',
          lowest > BB_DECK_Z,
          `lowest tube corner z ${lowest.toFixed(3)} vs deck ${BB_DECK_Z}`,
        );
      }

      // ── #15: THE DECK IS ONE NUMBER, AND IT IS THE SIM'S ───────────────────────────────
      //
      // ⚠️ THIS BLOCK USED TO ADD UP THE MUZZLE FROM SOURCE LITERALS — deck + head lift + an exit
      // left at the head's own origin — and compare the total to `BB_LAUNCH_Z0`. It passed every
      // time, because all three literals were there and they did add up. What it could not see is
      // that the total was only right AT ONE ELEVATION, which is the whole of the 2026-09-19
      // report. The muzzle is measured off the built mesh now, at 41 pitches, in the block above.
      // What is left here is the one statement that is still a statement about SOURCE: the deck
      // is not a second number.
      {
        check(
          'the drivetrain’s side plate IS the sim’s deck — imported, not a local 4.6',
          /const BB_PLATE_H = BB_DECK_Z;/.test(robotsCode) &&
            /export const BB_DRIVETRAIN_H = BB_PLATE_H;/.test(robotsCode) &&
            /\bBB_DECK_Z,/.test(robotsCode.slice(0, robotsCode.indexOf("} from '../config'"))),
          `BB_DECK_Z=${BB_DECK_Z}`,
        );
      }
    }

    const statsSrc = readFileSync(join(SCENE_DIR, 'renderStats.ts'), 'utf8');
    // the ATTRIBUTE, not the word: the file's own header explains at length why it does not
    // carry one, and a grep for the bare string finds that explanation
    check(
      'the overlay is NOT a HUD band (a diagnostic must not reframe the shot)',
      !/setAttribute\(\s*['"]data-hud-band/.test(statsSrc),
    );
  }

  // == LANE A (FIELD RENDER) -- the 2026-09-18 playtest's field items =======================
  //
  // Source + data checks only: this lane has no DOM and no `three`, and every one of these
  // guards a thing that is invisible until somebody looks at the field from the right angle.
  {
    const glbSrc = readFileSync(join(SCENE_DIR, 'renderFieldGlb.ts'), 'utf8');
    const fieldSrc = readFileSync(join(SCENE_DIR, 'renderField.ts'), 'utf8');
    const drawSrc = readFileSync(join(BIOBUZZ_DIR, 'drawField.ts'), 'utf8');

    // ITEM 1 -- CLEAR PLASTIC. The STEP paints clear polycarbonate the same placeholder white it
    // paints solid white parts, so the decision is a per-(node, material) rule in the loader. The
    // regression to catch is someone keying it on the material name alone: `plastic#e6e6e6` is a
    // clear CELL skin in a tray node and an opaque ACM logo board in the shared frame, and one
    // shared cache entry would hand both the same answer.
    check(
      'the clear-plastic rule is keyed on the NODE as well as the material (one glTF material name, two answers)',
      /function isClearPanel\([^)]*family: NodeFamily\)/.test(glbSrc) && glbSrc.includes("family === 'hive_tray'"),
    );
    check('the material cache key carries the node family', glbSrc.includes('@${here}'));
    // THE 2026-09-19 RE-TUNE. A clear panel is what the LAYERS sum to, so `FrontSide` is the
    // policy on BOTH paths — the first pass's `DoubleSide` doubled every surface in a line of
    // sight and the cell skins read as white boards. Read out of `clearPanelMaterial` ITSELF,
    // not out of the whole file: both files build opaque-ish decorations (`mat()`, the holding-box
    // sign) that are legitimately `DoubleSide`, and a file-wide grep cannot tell them apart.
    const panelMat = (src: string): string => {
      const at = src.indexOf('function clearPanelMaterial');
      const end = src.indexOf('\n}', at);
      return at < 0 || end < 0 ? '' : src.slice(at, end);
    };
    {
      const body = panelMat(glbSrc);
      // a clear panel is four things, not just a low opacity -- see the policy header
      check('a clear panel damps the environment map (what made these read as solid white)', body.includes('CLEAR_ENV_INTENSITY'));
      // ⚠️ `depthWrite: false` STAYS and `FrontSide` is GONE -- the second is the 2026-09-19
      // culling fix and the two are unrelated: depth-writing would let one clear panel occlude
      // another drawn after it, while the SIDE decides whether a sheet exists from behind at all.
      check('a clear panel still never writes depth', /depthWrite: false/.test(body));
    }
    // ⚠️ AND THERE IS ONLY ONE OF THEM NOW (2026-09-19, the owner's SECOND back-panel report).
    // This used to be a pair of checks comparing TWO `clearPanelMaterial`s -- one per path -- on
    // the two numbers a regex could reach, which is how the fallback field came to agree about
    // its opacities and about nothing else: the Fresnel alpha, the un-attenuated reflection and
    // the restored mirror all landed on the CAD path alone. A constants-path driver was looking
    // at the material from before the fix. The fallback imports this one instead, so the two
    // paths cannot drift at all rather than cannot drift in two places.
    {
      check(
        'the fallback field builds NO clear-panel material of its own',
        !fieldSrc.includes('function clearPanelMaterial'),
      );
      check(
        '...it imports the CAD path’s two clear surfaces by name',
        /import \{[^}]*\bcellPanelMaterial\b/s.test(fieldSrc) && /import \{[^}]*\bwallPanelMaterial\b/s.test(fieldSrc),
      );
      check(
        '...and keeps no second opacity of its own to drift',
        !/const (CELL|WALL)_OPACITY =/.test(fieldSrc),
      );
      // ⚠️ AND A CELL SKIN AND A WALL ARE NOT THE SAME CALL. They differ in two numbers and both
      // matter: the skin is denser AND it carries the veil. A `clearPanelMaterial(...)` written
      // out longhand anywhere else is how one of the two would quietly get the other's answer.
      check(
        'the two clear surfaces are built in exactly one place each',
        /export function cellPanelMaterial\(\): THREE\.Material \{\s*return clearPanelMaterial\(CELL_PANEL_OPACITY, PANEL_VEIL\);/.test(glbSrc) &&
          /export function wallPanelMaterial\(\): THREE\.Material \{\s*return clearPanelMaterial\(WALL_PANEL_OPACITY\);/.test(glbSrc),
      );
      check(
        '...and the perimeter wall takes NO veil (the 2026-09-18 white-board report stands)',
        !/wallPanelMaterial\(\)[\s\S]{0,120}PANEL_VEIL/.test(glbSrc) && clearPanelVeilAt(0, 0.08, 0.9) === 0,
      );
      const num = (src: string, name: string): number => {
        const m = new RegExp(`const ${name} = ([\\d.]+);`).exec(src);
        return m ? Number(m[1]) : NaN;
      };
      // the re-tune's DIRECTION, so nobody walks the file back to the first pass: a cell skin is
      // denser than the perimeter, and both are far below the rejected 0.22.
      //
      // ⚠️ AND THE CELL SKIN IS BACK AT 0.13, ON PURPOSE. Raising it to 0.18 was tried and
      // MEASURED on 2026-09-19: it moved the back view by 0.1 of a level, because alpha is a
      // multiplier on `bg - tint` and the ground behind a hive IS the tint's own value. What
      // answers that report is the VEIL, which adds; the opacity went back to where the
      // white-board re-tune had put it.
      const cell = num(glbSrc, 'CELL_PANEL_OPACITY');
      const wall = num(glbSrc, 'WALL_PANEL_OPACITY');
      check(
        'a clear panel is nearly invisible face-on, and a cell skin is the denser of the two',
        wall > 0 && wall <= 0.12 && cell > wall && cell <= 0.15,
        `wall ${wall}, cell ${cell}`,
      );
      check('the perimeter wall is UNCHANGED by the cell re-tune (0.08, measured)', wall === 0.08, `${wall}`);
    }

    // ITEM 3 -- THE STALE TRAY BRACES. `convert.py` files all eight `10.5in Churro Lite` as
    // `hive_frame`, but they ride the tray: in `field-colliders.json` they sit at the tray's own
    // 30-degree capture pose in a mirrored pair, which a static part cannot do. The loader moves
    // them back onto the tray; these checks prove the CLAIM about the data, so the day the
    // pipeline files them correctly this fails loudly rather than the reparent quietly doing
    // nothing.
    check(
      'the loader reparents the tray braces onto the tray group',
      glbSrc.includes('function reparentTrayBraces') && glbSrc.includes('braceTris'),
    );
    {
      const colliders = JSON.parse(readFileSync(join(root, 'public', 'models', 'biobuzz', 'field-colliders.json'), 'utf8')) as {
        statics: { name: string; points: number[] }[];
      };
      const braces = colliders.statics.filter((s) => s.name.includes('churro'));
      check('the CAD still files the eight tray braces as hive_frame statics (the defect this works around)', braces.length === 8, `${braces.length}`);
      let inBand = 0;
      let others = 0;
      for (const s of colliders.statics) {
        if (!s.name.startsWith('hive_')) continue;
        let hit = false;
        for (let i = 0; i < s.points.length; i += 3) {
          const y = s.points[i + 1];
          const z = s.points[i + 2];
          if (z >= 46 || (Math.abs(y) >= 11.5 && z >= 36)) hit = true;
        }
        if (s.name.includes('churro')) {
          if (hit) inBand++;
        } else if (hit) others++;
      }
      check('all eight braces fall inside the loader selector band', inBand === 8, `${inBand}/8`);
      check('and no other hive_frame static does (the selector cannot take a leg or a bracket)', others === 0, `${others}`);
    }

    // ITEM 8 -- THE HUMAN PLAYER'S NECTAR HOLDING BOX. The unlabelled CAD box in the drive team
    // area is hidden and the STANDARD HOLDING BOX (`am-5706 Artifact Tray`, the same part, at its
    // own CAD dimensions, drawn the way DECODE draws its human-player box) stands ON THE FLOOR
    // outside the perimeter instead, reading its count off `world.balls` (the same balls the HUD
    // counts) rather than storing one. 2026-09-19: it replaced a bespoke shelf on legs at table
    // height -- "it should use the standard holding box instead of this table thing".
    //
    // 2026-09-19, second pass -- the owner's three: the box MOVED clear of the score bar, the 3D
    // count plate over it is GONE, and the 2D field draws the same box. The dimensions and the
    // place now live in `src/games/biobuzz/nectarBox.ts` so both renderers read one copy; these
    // checks are against THAT module's exported geometry, not against a literal in either
    // renderer, because a literal is what let the two views disagree in the first place.
    check('the unlabelled CAD `stations` tray is hidden on the GLB path', fieldSrc.includes('fg.stations.visible = false'));
    check('the NECTAR box reads its count off the world own `stock` balls', /b\.state\.kind === 'stock' && b\.state\.alliance === a/.test(fieldSrc));
    check('and it is refreshed every frame from `updateBiobuzzField`', fieldSrc.includes('updateNectarBoxes(handles.boxes, world)'));
    {
      // the CAD part's own footprint, off `docs/biobuzz/field-cad-audit.md`'s bbox for
      // `am-5706 Artifact Tray` (71.650, -7.875, -0.589 -> 81.900, 7.875, 2.411). Checked on the
      // SHARED module's exports, which is what both renderers build from.
      for (const [name, got, want] of [
        ['depth', BB_BOX_DEPTH, 10.25],
        ['length', BB_BOX_LEN, 15.75],
        ['height', BB_BOX_H, 3],
      ] as const) {
        check(`the holding box uses the CAD tray's ${name} (${want} in)`, Math.abs(got - want) < 1e-9, `${got}`);
      }
      // ON THE GROUND. The shelf sat at z = 30 on legs; the box's floor slab is half its own
      // thickness off the tiles and the beads rest on that slab, so nothing floats.
      check('the holding box floor slab sits ON the tiles', fieldSrc.includes('floorSlab.position.set(cx, cy, BB_BOX_T / 2)'));
      check('and the nectar rest on the box floor, not at table height', fieldSrc.includes('BB_BOX_T + BB_NECTAR_R'));
      // NO COPLANAR BLACK-ON-RED (owner, 2026-09-21: "the black part and the red part is
      // meshing"): the dark slab is inset one wall thickness, so it never shares an outer face
      // with an alliance wall.
      check(
        'the holding box floor slab is INSET inside its walls — no face shared with a wall\'s outer face',
        fieldSrc.includes('new THREE.BoxGeometry(BB_BOX_DEPTH - 2 * BB_BOX_T, BB_BOX_LEN - 2 * BB_BOX_T, BB_BOX_T)') &&
          !fieldSrc.includes('new THREE.BoxGeometry(BB_BOX_DEPTH, BB_BOX_LEN, BB_BOX_T)'),
      );
      for (const gone of ['RACK_SHELF_Z', 'RACK_SHELF_T', 'RACK_DEPTH', ':leg', ':lip']) {
        check(`the shelf-on-legs geometry is gone (${gone})`, !fieldSrc.includes(gone), gone);
      }
    }

    // ITEM 8a -- THE 3D "NECTAR LEFT" BILLBOARD IS GONE (owner, 2026-09-19: "Get rid of the
    // in-game 3d display"). A canvas plate hung over the box and was repainted whenever the
    // count changed. Deleting the MESH alone would have left a live `CanvasTexture` on the box
    // handle, which `disposeObject3D` never reaches because it only walks what is still in the
    // graph -- so the checks are that the plate, its canvas, its texture and the handle field
    // are all gone, not just that the mesh stopped being added.
    for (const gone of ['drawBoxSign', 'BOX_SIGN_W', 'BOX_SIGN_H', ':sign']) {
      check(`the holding box's 3D count plate is gone (${gone})`, !fieldSrc.includes(gone), gone);
    }
    {
      // scoped to the BUILDER, not the file: `buildFloorTexture` legitimately makes a canvas
      // texture for the tile seam grid, and a file-wide grep cannot tell the two apart.
      const at = fieldSrc.indexOf('function buildNectarBox(');
      const body = at < 0 ? '' : fieldSrc.slice(at, fieldSrc.indexOf('function buildNectarBoxes', at));
      check(
        'the box builder makes no canvas, no texture and no billboard at all',
        body.length > 0 && !/canvas|Texture|PlaneGeometry|lookAt/i.test(body),
      );
      check(
        'and `BbNectarBox` is the group and the beads, with nothing left to leak',
        /export interface BbNectarBox \{[^}]*beads: THREE\.Mesh\[\];\s*\}/.test(fieldSrc) && !/sign/.test(fieldSrc.slice(fieldSrc.indexOf('export interface BbNectarBox'), fieldSrc.indexOf('export interface BbNectarBox') + 400)),
      );
    }

    // ITEM 8b -- WHERE IT STANDS. Three things, all of them the reason it moved.
    {
      const area = BB_TAPE.allianceArea;
      for (const a of ['red', 'blue'] as const) {
        const r = bbNectarBoxRect(a);
        const outward = Math.min(Math.abs(r.x0), Math.abs(r.x1)); // the edge nearest the wall
        const far = Math.max(Math.abs(r.x0), Math.abs(r.x1));
        check(`the ${a} nectar box stands outside the perimeter face`, outward > BB_HALF_X, `${outward.toFixed(2)} > ${BB_HALF_X}`);
        // (1) IT FITS IN WHAT THE 2D CAMERA SHOWS. `Camera.configure` fits exactly
        // `halfX + viewMargin`, so a box past that is cut off at the BOTTOM of the driver's 2D
        // screen -- which is the strip the score bar occupies. This is the check that keeps the
        // 2D copy honest; nothing else in the renderer can see it.
        check(
          `the ${a} nectar box fits inside BB_VIEW_MARGIN, so the 2D view cannot clip it`,
          far <= BB_HALF_X + BB_VIEW_MARGIN,
          `${far.toFixed(2)} <= ${BB_HALF_X + BB_VIEW_MARGIN}`,
        );
        // (2) IT IS OUTBOARD OF THE DRIVE TEAM AREA, on the DRIVER'S LEFT -- "place the human
        // player box off to the left side of the drive team box". Driver-left is +y for red and
        // -y for blue (red's driver stands at x < 0 looking along +x, so the camera's right
        // vector is -y; blue is the 180-degree rotation of that, NOT the x-mirror). Stated as
        // "the same side of the centreline as this alliance's own LOADING ZONE", which is a
        // point-symmetric statement and therefore cannot be got right for one alliance and
        // wrong for the other.
        const lzY = (BB_LZ[a].y0 + BB_LZ[a].y1) / 2;
        const near = Math.sign(lzY) > 0 ? r.y0 : r.y1;
        const tape = Math.max(...area[a].map((s) => Math.abs(s.y1)));
        check(`the ${a} nectar box is on its own driver's LEFT`, Math.sign(near) === Math.sign(lzY), `${near.toFixed(2)} vs LZ ${lzY.toFixed(2)}`);
        check(
          `the ${a} nectar box is clear of the drive team area (it used to sit in the middle of it)`,
          Math.abs(near) >= tape,
          `${Math.abs(near).toFixed(2)} >= ${tape}`,
        );
        // and it stays inside the field's own y footprint -- a box past the corner reads as
        // furniture belonging to nothing.
        check(
          `the ${a} nectar box stays within the field's y span`,
          Math.max(Math.abs(r.y0), Math.abs(r.y1)) <= BB_HALF_Y,
          `${Math.max(Math.abs(r.y0), Math.abs(r.y1)).toFixed(2)}`,
        );
      }
      // (3) POINT SYMMETRY, not a mirror. Blue's box is red's rotated 180 degrees about the
      // origin -- which is what puts it on blue's driver's left too.
      const red = bbNectarBoxRect('red');
      const blue = bbNectarBoxRect('blue');
      check(
        'blue nectar box is the POINT mirror of red (the x-mirror lands on the wrong half)',
        Math.abs(blue.x0 + red.x1) < 1e-9 && Math.abs(blue.y0 + red.y1) < 1e-9,
        `${JSON.stringify(blue)} vs ${JSON.stringify(red)}`,
      );
      for (const a of ['red', 'blue'] as const) {
        const r = bbNectarBoxRect(a);
        for (let i = 0; i < BB_BOX_SLOTS; i++) {
          const s = bbNectarBoxSlot(a, i);
          check(
            `${a} slot ${i} sits inside the tray, a nectar clear of its walls`,
            s.x - BB_NECTAR_R >= r.x0 && s.x + BB_NECTAR_R <= r.x1 && s.y - BB_NECTAR_R >= r.y0 && s.y + BB_NECTAR_R <= r.y1,
            `${s.x.toFixed(2)},${s.y.toFixed(2)}`,
          );
        }
      }
      // the 2 x 3 slot grid is DECODE's, and at this pitch two nectar clear each other on both
      // axes -- the five `spawn.ts` stages in one row inside a 15.75-in box would overlap.
      const d = 2 * BB_NECTAR_R;
      check('the slot pitch clears a nectar across the box depth', BB_BOX_DEPTH / 2 >= d, `${(BB_BOX_DEPTH / 2).toFixed(2)} >= ${d}`);
      check('and along it', BB_BOX_LEN / 3 >= d, `${(BB_BOX_LEN / 3).toFixed(2)} >= ${d}`);
      check('six slots hold the five staged nectar', BB_BOX_SLOTS >= 5, `${BB_BOX_SLOTS}`);
    }

    // ITEM 8c -- THE 2D FIELD DRAWS THE SAME BOX (owner, 2026-09-19: "Add the same andymark box
    // in the 2d game as well"). SOURCE, because there is no canvas in this lane: what matters is
    // that it comes from the SHARED module rather than from a second copy of the numbers, and
    // that it counts the same `stock` balls the 3D box and the HUD count.
    check(
      'the 2D field draws the holding box from the shared module',
      drawSrc.includes("from './nectarBox'") && /bbNectarBoxRect\(a\)/.test(drawSrc),
    );
    check('the 2D box draws its beads at the shared slot centres', drawSrc.includes('bbNectarBoxSlot(a, i)'));
    check('the 2D box counts the same `stock` balls', /b\.state\.kind === 'stock' && b\.state\.alliance === a/.test(drawSrc));
    check('and it prints no number on the field (nothing here is a letter or a digit)', !drawSrc.includes('NECTAR LEFT'));

    // ITEM 11 -- THE GARDEN'S CORNER. The CAD band stops 0.573in clear of the wall at the
    // alliance corner while `BB_GARDEN` -- the SCORED zone -- snaps that edge onto it, so the
    // drawn band stopped short of the corner it is defined to reach.
    for (const [rel, src] of [
      ['src/games/biobuzz/drawField.ts', drawSrc],
      ['src/games/biobuzz/scene/renderField.ts', fieldSrc],
    ] as const) {
      check(`${rel} draws the garden corner supplement as well as the CAD strips`, src.includes('BB_TAPE.gardenSupplement'), rel);
    }
    check('the CAD path draws the supplement as geometry (the GLB tape is real, so a painted copy would double it)', fieldSrc.includes('buildSupplementalTape'));
    for (const a of ['red', 'blue'] as const) {
      const patches = BB_TAPE.gardenSupplement[a];
      check(`${a}: exactly one garden supplement strip`, patches.length === 1, `${patches.length}`);
      const p = patches[0];
      const band = BB_TAPE.garden[a];
      const bandY0 = Math.min(...band.map((s) => s.y0));
      const bandY1 = Math.max(...band.map((s) => s.y1));
      check(`${a}: the supplement spans the band full 2-in width`, Math.abs(p.y0 - bandY0) < 1e-6 && Math.abs(p.y1 - bandY1) < 1e-6, `${p.y0}..${p.y1} vs ${bandY0}..${bandY1}`);
      check(`${a}: it reaches the perimeter face`, Math.abs(Math.max(Math.abs(p.x0), Math.abs(p.x1)) - BB_HALF_X) < 1e-3, `${p.x0}..${p.x1} vs ${BB_HALF_X}`);
      check(`${a}: and it is short -- a bridge, not a new marking`, p.x1 - p.x0 < 1, `${(p.x1 - p.x0).toFixed(3)}in`);
      const drawnX = [...band, p].flatMap((s) => [s.x0, s.x1]);
      const gardenX = Math.max(Math.abs(BB_GARDEN[a].x0), Math.abs(BB_GARDEN[a].x1));
      check(`${a}: the drawn band now reaches BB_GARDEN own corner`, Math.abs(Math.max(...drawnX.map(Math.abs)) - gardenX) < 1e-3, `${Math.max(...drawnX.map(Math.abs))} vs ${gardenX}`);
      check(`${a}: and BB_GARDEN is unchanged by it (the zone is built from TAPE.garden alone)`, BB_GARDEN[a].y1 - BB_GARDEN[a].y0 > 2 && BB_GARDEN[a].x1 - BB_GARDEN[a].x0 > 20);
    }

    // ITEM 2 -- THE FLOWER'S BACKSTOP (section 9.7, 1.25in tall). The CAD path draws the real
    // part; the constants fallback had no backstop at all, so a fallback field and a CAD field
    // disagreed about a surface a lob comes off.
    check('the constants fallback builds the flower backstop', fieldSrc.includes(':backstop') && /FLOWER_BACKSTOP_H = 1\.25/.test(fieldSrc));

    // == THE 2026-09-19 PLAYTEST, OWNER ITEMS 3, 4, 11 AND 13 ==============================

    // ITEM 3 -- NO OUTLINE PASS ON A CLEAR PANEL. `addPanelEdges` ran `EdgesGeometry(geo, 25)`
    // over a tray's merged, welded, per-primitive-decimated `plastic#e6e6e6` soup and drew 3,552
    // segments, 2,811 of them 0.01in or shorter and the LONGEST 0.84in -- on skins 20in wide.
    // Every one of them was a tessellation crease, which is the owner's "stray lines on the
    // transparent panels of the hives". Nothing replaces it: the CELL's shape is drawn by its two
    // opaque alliance-coloured GOAL RIBS, at both ends.
    // ⚠️ AGAINST THE CODE, NOT THE FILE. Both headers below NAME the thing they forbid, at
    // length, because the measurement that killed it is the reason it is forbidden — a file-wide
    // grep would fail on its own explanation.
    const glbCode = codeLines(join(SCENE_DIR, 'renderFieldGlb.ts')).join('\n');
    const fieldCode = codeLines(join(SCENE_DIR, 'renderField.ts')).join('\n');
    check('the loader runs no edge/outline pass at all', !/EdgesGeometry|LineSegments/.test(glbCode));
    check('and the constants fallback does not either', !/EdgesGeometry|LineSegments/.test(fieldCode));
    check(
      'the CAD asset still files the goal ribs as tray parts (they are what draws the cell now)',
      /PartRule\(r"goal rib", "hive_tray"/.test(readFileSync(join(root, 'scripts', 'field-cad', 'convert.py'), 'utf8')),
    );

    // ITEM 4 -- CREASED, NEVER SMOOTH. Neither GLB carries a NORMAL attribute, so the loader
    // computes one; computing it SMOOTH over a soup of merged hard-edged CAD parts put 63-75% of
    // triangles more than 45 degrees off their own face and left 15 normals at length zero, which
    // on a `metalness: 0.7` near-black bracket reads as the owner's "white artifacts".
    check('the loader computes CREASED normals', glbSrc.includes('computeCreasedNormals(obj.geometry, CREASE_ANGLE_DEG)'));
    check(
      'and never the smooth pass on a loaded mesh (the plain call survives only as the un-indexed fallback)',
      (glbCode.match(/computeVertexNormals\(\)/g) ?? []).length === 1,
      `${(glbCode.match(/computeVertexNormals\(\)/g) ?? []).length}`,
    );
    {
      // A WELDED CUBE. 8 shared vertices, 12 triangles: the split has to hand every corner three
      // normals and every triangle its own exact face normal.
      const cube = new THREE.BufferGeometry();
      const P: number[] = [];
      for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) P.push(x, y, z);
      cube.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
      // faces, wound outward: -x +x -y +y -z +z
      cube.setIndex([
        0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6,
      ]);
      computeCreasedNormals(cube, CREASE_ANGLE_DEG);
      const cn = cube.getAttribute('normal');
      check('a welded cube splits into 3 normals per corner', cn.count === 24, `${cn.count}`);
      let axisAligned = 0;
      const v = new THREE.Vector3();
      for (let i = 0; i < cn.count; i++) {
        v.fromBufferAttribute(cn, i);
        const s = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)].sort((a, b) => b - a);
        if (Math.abs(s[0] - 1) < 1e-5 && s[1] < 1e-5) axisAligned++;
      }
      check('every one of them is an exact face normal, not an average', axisAligned === cn.count, `${axisAligned}/${cn.count}`);
    }
    {
      // ⚠️ THE REGRESSION THAT COSTS THE MOST TO REDISCOVER. The first version grouped a vertex's
      // faces by UNION-FIND, which is transitive: on a finely tessellated cone every face is
      // within the crease angle of its neighbour, so one group spans 360 degrees and its
      // area-weighted average is the ZERO VECTOR. This fixture is a NEEDLE cone -- 24 faces whose
      // normals sweep the full turn nearly perpendicular to the axis -- and it is the shape that
      // separates the two: per corner the apex normal follows the cone's surface, per group it
      // collapses onto the axis (or to nothing).
      const N = 24;
      const cone = new THREE.BufferGeometry();
      const pos: number[] = [0, 0, 20];
      for (let i = 0; i < N; i++) pos.push(Math.cos((2 * Math.PI * i) / N), Math.sin((2 * Math.PI * i) / N), 0);
      cone.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      const idx: number[] = [];
      for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + ((i + 1) % N));
      cone.setIndex(idx);
      computeCreasedNormals(cone, CREASE_ANGLE_DEG);
      const nn = cone.getAttribute('normal');
      let short = 0;
      let axial = 0;
      const v = new THREE.Vector3();
      for (let i = 0; i < nn.count; i++) {
        v.fromBufferAttribute(nn, i);
        if (Math.abs(v.length() - 1) > 1e-4) short++;
        if (Math.abs(v.z) > 0.5) axial++;
      }
      check('a needle cone leaves no degenerate normal (the union-find version left the apex at zero)', short === 0, `${short}`);
      check('and its apex normals follow the surface rather than collapsing onto the axis', axial === 0, `${axial}/${nn.count}`);
    }

    // ITEM 11 -- THE FLOWER STANDOFFS. `am-1696: Nylon Spacer ... 1.000in Long` x2 per flower is
    // in the STEP and is swallowed by `convert.py`'s RE_FASTENER, which matches the bare words
    // `nylon spacer` -- the same defect audit section 2.2 records for the 24 perimeter rails
    // ("FTC Rail with Rivet Holes"). The loader rebuilds them at the CAD's own dimensions, and
    // the gap it stands them in is measurable straight off the measurements file.
    {
      const measurements = JSON.parse(readFileSync(join(root, 'public', 'models', 'biobuzz', 'field-measurements.json'), 'utf8')) as {
        flowers: { id: string; rings: { top: { z: [number, number] } }; backstopZ: [number, number] }[];
      };
      check('the measurements carry all four flowers', measurements.flowers.length === 4, `${measurements.flowers.length}`);
      for (const f of measurements.flowers) {
        const gap = f.backstopZ[0] - f.rings.top.z[1];
        check(
          `${f.id}: the purple backstop stands exactly one 1.000-in spacer off the top ring`,
          Math.abs(gap - 1) < 0.01,
          `${gap.toFixed(4)}in`,
        );
      }
      check(
        'the CAD still drops the spacer as a fastener (the defect this works around)',
        /nylon spacer/.test(readFileSync(join(root, 'scripts', 'field-cad', 'convert.py'), 'utf8')),
      );
      check('the standoff is built at the part number own OD', /STANDOFF_OD_IN = 0\.375/.test(glbSrc));
      check('its length is MEASURED between the two plates, not typed', /const height = plate\.min\.z - ring\.max\.z;/.test(glbSrc));
    }

    // ITEM 13 -- THE APRILTAG CLUSTERS AND THE BANNER. Both plates are already in the GLB as
    // `decal#ffffff` -- blank white, because a STEP carries no artwork. The IDs are section 9.9
    // p76, read off the page raster (that page's text layer drops the digits -- see
    // `docs/biobuzz/manual-distilled.md`'s own defect list), and the code table is
    // AprilRobotics/apriltag's `tag36h11.c`.
    {
      const seen = new Set<number>();
      for (const a of ['red', 'blue'] as const) {
        for (const side of ['north', 'south'] as const) {
          for (const id of BB_TAG_IDS[a][side]) seen.add(id);
        }
      }
      check('sixteen distinct tags, one cluster of four per CELL', seen.size === 16, `${seen.size}`);
      check('and every one of them is in the manual 30..45', [...seen].every((id) => id >= 30 && id <= 45));
      // the AUDIENCE is at -y (F4 is on the audience wall), so "opposite the audience" is +y
      check('red FAR (opposite the audience) is 30 31 32 33', BB_TAG_IDS.red.north.join(' ') === '30 31 32 33');
      check('red AUDIENCE is 34 35 36 37', BB_TAG_IDS.red.south.join(' ') === '34 35 36 37');
      check('blue AUDIENCE is 38 39 40 41', BB_TAG_IDS.blue.south.join(' ') === '38 39 40 41');
      check('blue FAR is 42 43 44 45', BB_TAG_IDS.blue.north.join(' ') === '42 43 44 45');

      // THE BITMAP, round-tripped. A tag is 10 cells including a 1-cell white quiet zone around
      // an 8-cell black border; the inner 6x6 carries the 36 code bits MSB first. Reading them
      // back out of the rendered grid has to reproduce `codedata[id]` exactly -- a mirrored or
      // transposed layout would still LOOK like a tag and would detect as nothing.
      const cells = [...seen].map((id) => ({ id, grid: apriltag36h11Cells(id) }));
      let wellFormed = 0;
      for (const { grid } of cells) {
        let ok = true;
        for (let k = 0; k < 10; k++) {
          if (grid[k] !== 1 || grid[90 + k] !== 1 || grid[k * 10] !== 1 || grid[k * 10 + 9] !== 1) ok = false;
        }
        // the black border ring, inside the quiet zone: row 1, row 8, col 1, col 8
        for (let k = 1; k < 9; k++) {
          if (grid[10 + k] !== 0 || grid[80 + k] !== 0 || grid[k * 10 + 1] !== 0 || grid[k * 10 + 8] !== 0) ok = false;
        }
        if (ok) wellFormed++;
      }
      check('every tag has a white quiet zone and a closed black border', wellFormed === 16, `${wellFormed}/16`);
      check(
        'and its 36 data bits read back as `tag36h11.c` own codedata (ID 30 = 0x0e2cfda160)',
        readTagCode(apriltag36h11Cells(30)) === 0x0e2cfda160 && readTagCode(apriltag36h11Cells(45)) === 0x0fbb59375d,
        `${readTagCode(apriltag36h11Cells(30)).toString(16)}`,
      );
      const keys = new Set(cells.map((c) => c.grid.join('')));
      check('the sixteen bitmaps are all different', keys.size === 16, `${keys.size}`);

      // the manual's own figures, and the one place this pass could not honour Fig 9-15
      check('a tag is the 3.25in square section 9.9 states', /TAG_SIZE_IN = 3\.25/.test(glbSrc));
      check(
        'the row pitch clears a tag (Fig 9-15 distilled 2.75in centres would overlap two by half an inch)',
        /TAG_PITCH_IN = 3\.5/.test(glbSrc),
      );
      check('and the pitch is flagged APPROX with the reason', /APPROX -- THE MANUAL'S OWN PITCH CANNOT BE RIGHT|APPROX — THE MANUAL/.test(glbSrc));

      // the PLATES are measured, not typed -- the CAD is authoritative for dimensions
      check('the plate rectangles come off the CAD mesh (`facetFrame`), not out of this file', /function facetFrame\(/.test(glbSrc));
      check('no plate rectangle is hard-coded', !/17\.0005|5\.0009/.test(glbCode));
      check('the banner is TEXT, with no FIRST or RTX logo artwork fetched or embedded', !/data:image|logo|\.svg|\.png/i.test(glbCode));

      // THE TIER GATE. Nothing above is built, no canvas is allocated and no texture is uploaded
      // on the LOW LOD, which is the `meshDetail` row of the preset table and therefore the LOW
      // tier alone.
      check('the markings are built on the HIGH LOD only', /quality === 'high' \? buildFieldMarkings\(/.test(glbSrc));
      check('...and the low LOD gets a zeroed record rather than a partial one', /: NO_MARKINGS;/.test(glbSrc));
      check('mesh detail is `low` on the LOW tier alone', GFX_PRESETS.low.meshDetail === 'low' && (['medium', 'high', 'ultra'] as const).every((t) => GFX_PRESETS[t].meshDetail === 'high'));
    }

    // == THE 2026-09-19 OWNER PASS, ITEMS 6 AND 8, AND THE STICKER LABEL ===================

    // ITEM 13a -- THE LABEL IS FIG 9-16'S, NOT A CAPTION. `manual-distilled.md` §9.9: "The
    // cluster sticker in Fig 9-16 is labelled per cell, e.g. 'RED AUDIENCE / Tag family: 36h11'."
    // It was drawn as one line with the four IDs appended, which the real sticker does not carry.
    {
      check(
        'the sticker label is the CELL name over `Tag family: 36h11`, on two lines',
        glbCode.includes('ctx.fillText(label,') && glbCode.includes('ctx.fillText(`Tag family: ${TAG_FAMILY}`'),
      );
      check('...and the IDs are no longer lettered beside it', !glbCode.includes("${ids.join(' ')}"));
      check('the four cell names are the manual own', Object.values(TAG_LABEL_EXPECTED).join('|') === 'RED FAR|RED AUDIENCE|BLUE FAR|BLUE AUDIENCE');
      for (const [a, side, want] of TAG_LABEL_ROWS) {
        check(`Fig 9-16 labels the ${a} ${side} cell "${want}"`, glbSrc.includes(`${side}: '${want}'`), want);
      }
      // the tag BITMAPS are untouched -- they are real 36h11 and the block above round-trips them
      check('the label change did not touch the tag raster', glbSrc.includes('TAG_CELL_PX = 12') && glbSrc.includes('magFilter = THREE.NearestFilter'));
    }

    // ITEM 6 -- THE STICKER BLEEDS THROUGH FROM ABOVE, AND CANNOT BE READ FROM THERE.
    //
    // §9.9 keeps the cluster on the BOTTOM face of each CELL facing DOWN -- that is unchanged and
    // checked first, because the fix must not move the real sticker. What is ADDED is the white
    // vinyl coming through the translucent floor when you look down at it (owner, 2026-09-19).
    //
    // ⚠️ THE UNDECODABILITY IS A RASTER PROPERTY, NOT AN OPACITY. A faint but CRISP copy still
    // carries all 36 bits; a detector thresholds and does not care how grey the ink is. So the
    // check is on the PITCH: the bleed canvas is rasterized coarser than a tag CELL, so the
    // rasterizer averages the bits away before the texture exists.
    {
      check(
        '§9.9 is intact: the crisp cluster still faces DOWN off the cell floor',
        glbSrc.includes('const DOWN = new THREE.Vector3(0, 0, -1)') &&
          glbSrc.includes('facetFrame(mesh, (_cx, cy) => Math.sign(cy) === sideSign, DOWN,') &&
          glbSrc.includes('quad.position.copy(frame.centre).addScaledVector(DOWN, MARKING_LIFT_IN)'),
      );
      check(
        'and a SECOND, faint quad is built on the UPPER face of the same plate',
        glbSrc.includes('bleed.name = `bb-apriltag-bleed:${alliance}:${side}`') &&
          glbSrc.includes('bleed.position.set(frame.centre.x, frame.centre.y, topZ + MARKING_LIFT_IN)'),
      );
      // ⚠️ IT IS THE STICKER'S OWN RECTANGLE, LIFTED AND MIRRORED, NOT A SECOND MEASUREMENT.
      // Measured on the shipped `field.glb`: `facetFrame(..., UP, ...)` over the same plate
      // returns a 14.434 x 0.123-in STRIP, because the decimator kept almost none of the face
      // the plate is pressed against. A bleed built on that sits 2.3 in off the sticker and is
      // 40x too thin. Both statements are checked, so nobody "simplifies" it back.
      check(
        '...on the SAME rectangle the sticker uses (a second facetFrame measures a lip)',
        /new THREE\.PlaneGeometry\(frame\.width, frame\.height\),\s*bleedMaterial\(tagBleedTexture\(ids, frame\.width, frame\.height\)\),/.test(glbSrc),
      );
      check(
        '...at the CAD plate own top face, not a typed thickness',
        glbSrc.includes('const topZ = new THREE.Box3().setFromObject(mesh).max.z;'),
      );
      check(
        '...and MIRRORED, which is what looking through a translucent panel does',
        glbSrc.includes('makeBasis(new THREE.Vector3(sideSign, 0, 0), new THREE.Vector3(0, sideSign, 0), UP)'),
      );
      check('one per CELL, counted beside the stickers', /tagBleeds: number;/.test(glbSrc) && glbSrc.includes('out.tagBleeds++'));
      check('...and the low LOD still zeroes every marking', glbSrc.includes('const NO_MARKINGS: FieldMarkings = { tagPlates: 0, tagBleeds: 0, banners: 0, standoffs: 0 }'));

      // the four tuning values below are restated in this file rather than imported, so the
      // checks test a VALUE and not the same symbol the renderer reads. That only works if the
      // two copies agree, which is this check.
      check(
        'the bleed tuning this lane checks against is the renderer own',
        glbSrc.includes(`const TAG_BLEED_PX_PER_IN = ${TAG_BLEED_PX_PER_IN};`) &&
          glbSrc.includes(`const TAG_BLEED_OPACITY = ${TAG_BLEED_OPACITY_EXPECTED};`) &&
          glbSrc.includes(`const TAG_BLEED_WHITE = '${TAG_BLEED_WHITE_EXPECTED}';`) &&
          glbSrc.includes(`const TAG_BLEED_INK = '${TAG_BLEED_INK_EXPECTED}';`),
      );

      // THE GUARANTEE. A 36h11 decoder samples one bit per tag CELL; a bleed pixel that spans
      // more than one cell cannot hold one.
      const pitchIn = 1 / TAG_BLEED_PX_PER_IN;
      check(
        'the bleed raster is COARSER than a 36h11 cell, so no pixel can hold one bit',
        pitchIn > TAG_CELL_IN,
        `${pitchIn.toFixed(3)}in per pixel vs a ${TAG_CELL_IN.toFixed(3)}in cell`,
      );
      check(
        '...and coarser by a margin, not by a hair (>= 2 cells per pixel)',
        pitchIn >= 2 * TAG_CELL_IN,
        `${(pitchIn / TAG_CELL_IN).toFixed(2)} cells per pixel`,
      );
      // a whole 3.25-in tag lands on ~4.5 px, so a cluster of four is a smudge and not a grid
      check(
        'a whole tag lands on a handful of pixels',
        TAG_SIZE_IN * TAG_BLEED_PX_PER_IN < 6,
        `${(TAG_SIZE_IN * TAG_BLEED_PX_PER_IN).toFixed(2)} px across`,
      );
      check(
        'the bleed is SMEARED on the way back up, never `NearestFilter` (which would give hard blocks)',
        /function tagBleedTexture[\s\S]*?magFilter = THREE\.LinearFilter/.test(glbSrc),
      );
      // and it is a stain, not a sticker: translucent, low contrast, no shadow, not `decalMaterial`
      check('the bleed material is translucent and writes no depth', /function bleedMaterial[\s\S]*?transparent: true,[\s\S]*?depthWrite: false,/.test(glbSrc));
      check('the bleed is much fainter than the sticker below it', TAG_BLEED_OPACITY_EXPECTED <= 0.35, `${TAG_BLEED_OPACITY_EXPECTED}`);
      check('...and casts no shadow', glbSrc.includes('bleed.castShadow = false'));
      // LOW contrast: the two tones it paints are near each other and near white, so even the
      // blocks the raster leaves are a suggestion rather than a black-and-white pattern
      {
        const lum = (hex: string): number => {
          const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        };
        const ratio = (lum(TAG_BLEED_WHITE_EXPECTED) + 0.05) / (lum(TAG_BLEED_INK_EXPECTED) + 0.05);
        check(
          'the bleed pair is LOW contrast (the sticker itself is 21:1 black on white)',
          ratio < 2,
          `${ratio.toFixed(2)}:1`,
        );
      }
    }

    // ⚠️ IT WAS BACK-FACE CULLING, AND THIS IS THE CHECK THAT WOULD HAVE SAID SO.
    //
    // The 2026-09-19 header said "it is NOT back-face culling -- 0 boundary edges, face normals in
    // matched opposite pairs (+-y 1,203/1,233, +-x 204/192), so every skin is a closed slab". That
    // count binned only AXIS-ALIGNED normals and a cell's back is a GABLE: its two sheets are
    // diagonal, normal ~ (0.54, 0, +-0.84) in the tray frame, so they were in neither bin. Three
    // passes of SHADING fixes followed, on faces that were not being rasterised from behind.
    //
    // So this measures the asset PER PLANE, with the loader's own exported function: a closed slab
    // puts its two faces in one plane cluster and splits the area both ways, an open sheet puts all
    // of it one way. Run over the shipped `.glb` in Node -- no GL context, no camera, no opinion.
    {
      const scene = FIELD_GLB_SCENE;
      check('field.glb parses headlessly, so the asset itself can be measured here', scene !== null);
      if (scene) {
        scene.updateMatrixWorld(true);
        const clear: { name: string; frac: number; area: number; planes: number }[] = [];
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh || !mesh.geometry) return;
          const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          const mn = mat?.name ?? '';
          const node = String((o.parent?.userData as { name?: string })?.name ?? o.parent?.name ?? '');
          const isTraySkin = mn === 'plastic#e6e6e6' && /^hive_(red|blue)[/]?tray$/.test(node);
          const isWallGlass = mn.startsWith('glass#');
          if (!isTraySkin && !isWallGlass) return;
          const r = sheetFacingBalance(mesh.geometry, mesh.matrixWorld);
          clear.push({ name: `${node || 'walls'} ${mn}`, frac: r.twoFacedFraction, area: r.totalArea, planes: r.planes });
        });
        check('the GLB carries the clear tray skins and the perimeter glass', clear.length >= 3, `${clear.length} primitives`);
        for (const c of clear) {
          check(
            `EVERY clear surface is open SHEETING, not a closed slab -- ${c.name}`,
            c.frac < 0.1,
            `two-faced ${(c.frac * 100).toFixed(1)}% of ${c.area.toFixed(0)} sq in over ${c.planes} planes`,
          );
        }
        // ...which is exactly why the material may not cull a face. The two travel together.
        check(
          'so the clear material is DoubleSide, keyed on that measurement',
          CLEAR_SHEETS_ARE_SINGLE_SIDED &&
            glbSrc.includes('side: CLEAR_SHEETS_ARE_SINGLE_SIDED ? THREE.DoubleSide : THREE.FrontSide'),
        );
      }
      // THE FUNCTION ITSELF, against geometry whose answer is known -- a lane check that only ever
      // sees one asset cannot tell "measured" from "always returns 0".
      const slab = new THREE.BoxGeometry(20, 12, 0.02).toNonIndexed();
      const sheet = new THREE.PlaneGeometry(20, 12).toNonIndexed();
      check('a closed SLAB measures two-faced', sheetFacingBalance(slab).twoFacedFraction > 0.9, `${sheetFacingBalance(slab).twoFacedFraction.toFixed(3)}`);
      check('...and a single SHEET measures single-sided', sheetFacingBalance(sheet).twoFacedFraction < 0.01, `${sheetFacingBalance(sheet).twoFacedFraction.toFixed(3)}`);
    }

    // ITEM 8 -- A CLEAR PANEL IS A DIELECTRIC, NOT A CONSTANT ALPHA.
    //
    // Owner, 2026-09-19, and the fix above is the one that answered it. What follows is the
    // SHADING half, which stands on its own: a constant alpha divides a panel's own reflection by
    // that alpha, and a reflection
    // does not pass through the sheet. See `clearPanelMaterial`'s header.
    //
    // ⚠️ AND THE ANSWER MUST NOT BRING BACK THE STRAY DASHES. `addPanelEdges` is what was removed
    // to fix owner bug 3, and the "no edge/outline pass at all" check above is what keeps it out.
    // These add the second half of that guard: the fix is a per-pixel SHADER term, so it builds
    // no geometry and no mesh either.
    {
      check(
        'the panel takes polycarbonate own IOR, and every other number derives from it',
        /const PANEL_IOR = 1\.586;/.test(glbSrc) && /ior: PANEL_IOR/.test(glbSrc),
      );
      check(
        'the alpha is FRESNEL-weighted, in the shader, on |N.V| (so behind behaves like in front)',
        glbSrc.includes('mat.onBeforeCompile = (shader)') &&
          glbSrc.includes('abs( dot( normalize( normal ), normalize( vViewPosition ) ) )') &&
          glbSrc.includes('float bbFresnel = mix( diffuseColor.a,'),
      );
      check(
        '...and the SHEET HAS THICKNESS, which is the term that carries an ordinary look',
        glbSrc.includes('float bbPath = 1.0 - pow( 1.0 - diffuseColor.a, 1.0 / bbCos );') &&
          glbSrc.includes('diffuseColor.a = min( max( bbPath, bbFresnel ),'),
      );
      check(
        '...and the injected program is CACHE-KEYED, or three hands every panel the first one',
        glbSrc.includes('mat.customProgramCacheKey = () =>'),
      );
      check(
        'the reflected term is added back un-attenuated, capped',
        glbSrc.includes('reflectedLight.directSpecular + reflectedLight.indirectSpecular') &&
          glbSrc.includes('outgoingLight += bbSpec * min( 1.0 / max( diffuseColor.a, 0.02 ) - 1.0,'),
      );
      // ⚠️ AND THE MIRROR IS NOT DAMPED WITH THE DIFFUSE. `envMapIntensity` scales BOTH the
      // environment's irradiance and its radiance, and 0.15 was set to stop a near-white
      // placeholder base soaking up a warm HDRI -- it took the REFLECTION down with it, so a sheet
      // whose own `PANEL_F0` says 5.1% was mirroring 0.8% of the room. That is the one term that
      // is both light-rig-independent and background-independent, and it was the missing half of
      // the first back-panel fix.
      check(
        'the env damper is DIFFUSE-only: the mirror is restored to 1.0 in the shader',
        /const PANEL_ENV_SPEC_RESTORE = 1 \/ CLEAR_ENV_INTENSITY;/.test(glbSrc) &&
          glbSrc.includes('reflectedLight.indirectSpecular * ${PANEL_ENV_SPEC_RESTORE.toFixed(4)}'),
      );

      // THE CURVE, run rather than grepped -- the shader's own `pow(1-c,5)` is this reduced.
      for (const base of [0.08, 0.13] as const) {
        check(
          `face-on, a ${base} panel is still EXACTLY ${base} (the white-board re-tune is untouched)`,
          Math.abs(clearPanelAlphaAt(base, 1) - base) < 1e-12,
          `${clearPanelAlphaAt(base, 1)}`,
        );
        check(
          `...and at grazing it reaches the panel graze alpha, from ${base}`,
          Math.abs(clearPanelAlphaAt(base, 0) - 0.55) < 1e-12,
          `${clearPanelAlphaAt(base, 0)}`,
        );
        // MONOTONE, and symmetric in the sign of N.V: a panel seen from behind is the same panel
        let prev = clearPanelAlphaAt(base, 1);
        let monotone = true;
        let symmetric = true;
        for (let k = 20; k >= 0; k--) {
          const c = k / 20;
          const a = clearPanelAlphaAt(base, c);
          if (a < prev - 1e-12) monotone = false;
          if (Math.abs(a - clearPanelAlphaAt(base, -c)) > 1e-12) symmetric = false;
          prev = a;
        }
        check(`the ${base} panel alpha rises monotonically off normal`, monotone);
        check(`...and is identical for a NEGATIVE N.V (the whole of "from behind")`, symmetric);
        // ⚠️ THE FIRST PASS'S CLAIM HERE WAS THE BUG, AND THE CHECK THAT PINNED IT PASSED.
        // Schlick's fifth power moves nothing until the last 20 deg (at 45 deg the excess is
        // 0.010), and the header defended that as "the term buys the EDGE: a slab's 0.020-in side
        // face is at grazing from almost everywhere". At 78 in, a driver's distance from a hive,
        // that face is 0.03 px wide. It draws nothing, which is why the owner reported the same
        // panel twice. What a sheet at an angle actually shows is MORE SHEET -- Beer-Lambert over
        // the path length -- and that is now the term that carries an ordinary off-normal look,
        // while the face-on value stays exactly where it was measured.
        {
          const at = (deg: number): number => clearPanelAlphaAt(base, Math.cos((deg * Math.PI) / 180));
          check(
            `${base}: a 45 deg look is THICKER than face-on, by a visible margin`,
            at(45) > base * 1.25,
            `${at(45).toFixed(4)} vs ${base}`,
          );
          check(
            `${base}: ...and the rise starts early -- 30 deg is already above face-on`,
            at(30) > base * 1.08,
            `${at(30).toFixed(4)} vs ${base}`,
          );
          check(
            `${base}: ...and at 80 deg the edge is real (more than double)`,
            at(80) > base * 2,
            `${at(80).toFixed(4)} vs ${base}`,
          );
          check(
            `${base}: ...and nothing ever exceeds the graze ceiling`,
            at(1) <= 0.55 + 1e-12 && at(89) <= 0.55 + 1e-12,
            `${at(89).toFixed(4)}`,
          );
        }
      }
      // THE SHEEN GAIN: face-on is exactly where the panel needs it most, and the cap does not
      // bind on either shipped opacity (it exists so a future lower one cannot divide by ~0).
      check('the sheen gain restores the reflection face-on', clearPanelSheenGain(0.13) > 6, `${clearPanelSheenGain(0.13).toFixed(2)}x`);
      check('...more so on the thinner perimeter panel', clearPanelSheenGain(0.08) > clearPanelSheenGain(0.13));
      check('...and the cap never binds on a shipped value', clearPanelSheenGain(0.08) < 12, `${clearPanelSheenGain(0.08).toFixed(2)}`);
      check('...but does bind on an absurd one', clearPanelSheenGain(0.001) === 12);

      // ⚠️ THE CLAIM THIS PASS IS ACTUALLY MAKING, AS A NUMBER RATHER THAN AS SHADER TEXT.
      // The first fix passed every text check it had while being invisible from behind, because
      // what it restored was the SPECULAR -- and the measurement that followed showed the key
      // light is exactly what a face pointing away from it does not get. Moving the sun through
      // four positions swung the back view 3.0% -> 13.1% and left the mouth-side view flat, so
      // the panel needs a floor that no light position can take away. These pin it.
      for (const base of [0.08, 0.13] as const) {
        // a face turned right away from the rig still has the mirror AND its own body
        const away = clearPanelLightIndependent(base, 0.85);
        check(
          `${base}: a face pointing away from every light still contributes`,
          away.total >= base && away.mirror > 0 && away.body > 0,
          `mirror ${away.mirror.toFixed(4)} + body ${away.body.toFixed(4)} = ${away.total.toFixed(4)}`,
        );
        // the mirror is at the dielectric's own strength, not at 15% of it
        const damped = away.mirror / (1 + clearPanelSheenGain(clearPanelAlphaAt(base, 0.85)));
        check(
          `${base}: ...and the mirror is the restored one, several times the damped term`,
          away.mirror > damped * 4,
          `${away.mirror.toFixed(5)} vs damped ${damped.toFixed(5)}`,
        );
        // and it never runs away: the light-independent floor stays well under an opaque sheet
        check(`${base}: ...and it is a floor, not a white board`, away.total < 0.5, `${away.total.toFixed(4)}`);
      }
      // a CELL skin carries more of that floor than a perimeter panel, the same way its alpha does
      check(
        'a cell skin has more body from behind than a wall panel',
        clearPanelLightIndependent(0.13, 0.85).total > clearPanelLightIndependent(0.08, 0.85).total,
      );

      // ⚠️ THE VEIL -- THE TERM THAT ADDS, AND THE ONLY ONE THAT SURVIVES A MID-TONE GROUND.
      //
      // Three passes at this bug were spent on terms that MULTIPLY `bg - tint`: a Fresnel alpha, a
      // restored mirror, a damped ambient, and finally the alpha itself at 0.18. Every one of them
      // moved the owner's view by under 0.1 of a level, because `CLEAR_PANEL_TINT` is a mid grey
      // and the lit room behind a hive is its own value -- the difference they were scaling was
      // already zero. These checks are about the term that does not multiply anything.
      {
        const veilSrc = /const PANEL_VEIL = ([\d.]+);/.exec(glbSrc);
        const veil = veilSrc ? Number(veilSrc[1]) : NaN;
        check('the cell skins carry a veil, and it is a real number', Number.isFinite(veil) && veil > 0, `${veil}`);
        check(
          'it is ADDED in the shader, un-attenuated, and not blended toward the tint',
          glbSrc.includes('float bbVeilG = min( 1.0 / max( diffuseColor.a, 0.02 ),') &&
            /outgoingLight \+= vec3\( \$\{veilRgb\.r/.test(glbSrc),
        );
        check(
          '...in its own COOL NEAR-WHITE, not the transmission tint',
          /const PANEL_VEIL_TINT = 0xdfe6ec;/.test(glbSrc) && glbSrc.includes('setHex(PANEL_VEIL_TINT, THREE.SRGBColorSpace)'),
        );
        // IT DOES NOT DEPEND ON THE LIGHT OR ON THE VIEW. The JS mirror takes neither, and the
        // shader's own expression names no light term -- that is the whole of the owner's report.
        check(
          '...and it is LIGHT-INDEPENDENT: the veil expression names no light term',
          (() => {
            const at = glbSrc.indexOf('float bbVeilT =');
            const end = glbSrc.indexOf('#include <opaque_fragment>', at);
            const body = at < 0 ? '' : glbSrc.slice(at, end);
            return body.length > 0 && !/reflectedLight|directLight|irradiance|hemisphere/i.test(body);
          })(),
        );
        // ONE SKIN, in the band the measurement asked for, against ANY ground -- the value is the
        // same number three times because an added term does not care what is behind it.
        // ⚠️ IT IS SMALL, AND IT WAS NOT ALWAYS. 0.075 was tuned while two thirds of the clear
        // surface was being back-face culled from behind, so the veil was standing in for sheets
        // that were simply not drawn. With the sheets back it is 0.018 -- a floor under the
        // geometry, not a substitute for it.
        const one = clearPanelVeilAt(veil, 0.13, 0.9);
        check('one cell skin adds a real, background-independent amount', one > 0.01 && one < 0.06, `${one.toFixed(4)}`);
        check(
          '...and it is the same amount whichever way the skin faces (|N.V| is symmetric)',
          Math.abs(clearPanelVeilAt(veil, 0.13, 0.9) - clearPanelVeilAt(veil, 0.13, -0.9)) < 1e-12,
        );
        // THE STACK. `FrontSide` leaves three of these between the eye and an element through the
        // mouth, and each ADDS -- so the per-skin value is sized against the stack, not on its own.
        const stack = 3 * clearPanelVeilAt(veil, 0.13, 0.55);
        check('the worst stack is capped well short of an opaque sheet', stack < 0.55, `${stack.toFixed(4)} over 3 skins`);
        check(
          '...because the graze growth is bounded, not free',
          /const PANEL_VEIL_GRAZE_MAX = [\d.]+;/.test(glbSrc) &&
            clearPanelVeilAt(veil, 0.13, 0.05) < clearPanelVeilAt(veil, 0.13, 1) * 2,
          `${clearPanelVeilAt(veil, 0.13, 0.05).toFixed(4)} vs ${clearPanelVeilAt(veil, 0.13, 1).toFixed(4)}`,
        );
        // AND THE PERIMETER WALLS GET NONE OF IT. The 2026-09-18 report about those was that they
        // read as solid beige bands; they measure present from every camera the probe checks.
        check('a wall panel has no veil at all', clearPanelVeilAt(0, 0.08, 0.9) === 0);
        check(
          '...and `clearPanelPresence` splits the three terms so the lane can name which moved',
          (() => {
            const p = clearPanelPresence(veil, 0.13, 0.9);
            return p.veil > 0 && p.mirror > 0 && p.body > 0;
          })(),
        );
      }

      // THE ROUGHNESS -- the half of the fix that does not depend on the viewing angle
      check('a season-old panel is not showroom acrylic', /const PANEL_ROUGHNESS = 0\.18;/.test(glbSrc) && !/roughness: 0\.08/.test(glbCode));

      // ⚠️ AND NO STRAY DASHES CAME BACK WITH IT. Three statements, all over the CODE:
      check('ITEM 8 adds no edge pass (the file-wide guard, restated against THIS change)', !/EdgesGeometry|LineSegments/.test(glbCode));
      {
        const at = glbCode.indexOf('function clearPanelMaterial');
        const body = at < 0 ? '' : glbCode.slice(at, glbCode.indexOf('\n}', glbCode.indexOf('onBeforeCompile', at)));
        check(
          '...and the panel material builds no geometry and no mesh of its own',
          body.length > 0 && !/new THREE\.Mesh\(|Geometry\(|new THREE\.Line/.test(body),
          `${body.length} chars`,
        );
        check('...it is one material, whose only addition is a fragment-shader replace', body.includes('shader.fragmentShader = shader.fragmentShader.replace('));
        // the FrontSide / depthWrite policy the 2026-09-19 re-tune set is unchanged by all this
        check('...and depthWrite:false survives it', /depthWrite: false/.test(body));
      }
    }

    // ITEM 13b -- THE ACM PANEL IS BLANK, BECAUSE THE CAD SHIPS IT BLANK.
    //
    // `am-5883: Panel Sticker` x2 arrives as `decal#ffffff` with no artwork (the blank-decal
    // inventory above records it). The renderer used to letter "F I R S T  T E C H  C H A L L E
    // N G E" / "BIOBUZZ" / an amber rule onto it -- invented artwork on blank source data.
    // A hand-redrawn wordmark is not the alternative either: FIRST's trademark policy restricts
    // the LOGO marks to registered teams, committees/partners and written agreements, and the
    // brand guidelines forbid altered versions. So: a blank panel, shaded to read as a physical
    // sheet. §9 notes the logo panel may not be present at all events, so this is a real field.
    {
      check('the banner embeds or fetches NO logo artwork (unchanged, and it stays)', !/data:image|logo|\.svg|\.png/i.test(glbCode));
      {
        const at = glbCode.indexOf('function bannerTexture(');
        const body = at < 0 ? '' : glbCode.slice(at, glbCode.indexOf('\n}', at));
        check('the banner letters NOTHING -- no wordmark, no season name, no invented text', body.length > 0 && !/fillText|strokeText|\.font\s*=/.test(body), `${body.length} chars`);
        check('...and the three invented marks are gone by name', !/F I R S T|BIOBUZZ.*fillText|#ffba52/.test(body));
        check('it draws a SHEET instead: a gradient face and a soft wrapped edge', body.includes('createLinearGradient') && body.includes('PANEL_STICKER_EDGE'));
        // ...as a filled band, not a stroked outline -- a 1-px stroke on a quad leaning 24 deg
        // aliases into exactly the dashes owner bug 3 was about
        check('...with no stroked outline anywhere in it', !/stroke/i.test(body));
      }
      check('the panel face is semi-gloss composite, not a matt floor decal', glbSrc.includes('function panelStickerMaterial(') && glbSrc.includes('panelStickerMaterial(bannerTexture('));
      check('and the reasoning is recorded where the next session will read it', /Policy on the Use of FIRST\s+\*?\s*Trademarks/.test(glbSrc) || /Trademarks and Copyrighted Materials/.test(glbSrc));
      check('...including that the CAD sticker is the source of truth for it being blank', /am-5883/.test(glbSrc));
    }
  }
}

/** Fig 9-16's four cell names, written out here rather than imported, so the renderer's own
 *  table is checked against a second copy. */
const TAG_LABEL_EXPECTED = { redNorth: 'RED FAR', redSouth: 'RED AUDIENCE', blueNorth: 'BLUE FAR', blueSouth: 'BLUE AUDIENCE' } as const;
const TAG_LABEL_ROWS = [
  ['red', 'north', 'RED FAR'],
  ['red', 'south', 'RED AUDIENCE'],
  ['blue', 'north', 'BLUE FAR'],
  ['blue', 'south', 'BLUE AUDIENCE'],
] as const;
/** the bleed's shipped tuning, restated here so the checks above test the VALUE rather than
 *  reading the same symbol the renderer does. */
const TAG_BLEED_PX_PER_IN = 1.4;
const TAG_BLEED_OPACITY_EXPECTED = 0.3;
const TAG_BLEED_WHITE_EXPECTED = '#f2f4f6';
const TAG_BLEED_INK_EXPECTED = '#a8b2bc';

/** read the 36 code bits back out of a rendered 36h11 grid, MSB first at the published
 * `bit_x`/`bit_y` offsets — the inverse of `apriltag36h11Cells`, written out longhand here so the
 * round-trip is not checked against the same table that produced it. */
function readTagCode(grid: Uint8Array): number {
  const bitX = [1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4, 1, 1, 1, 1, 1, 2, 2, 2, 3];
  const bitY = [1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4];
  let code = 0;
  for (let i = 0; i < 36; i++) code += grid[(bitY[i] + 1) * 10 + (bitX[i] + 1)] * 2 ** (35 - i);
  return code;
}

/**
 * E1 — THE FIELD'S ON-SCREEN RECT IS A FUNCTION OF THE VIEWPORT, NEVER OF MATCH STATE.
 *
 * `GameController.refreshHudInsets` measures every `[data-hud-band]` and the 3D camera frames
 * the field into what is left, so a band that mounts, unmounts or resizes mid-match moves the
 * field under the driver. BIOBUZZ's cue row did exactly that — it was `{(nectarLocked || pin) &&
 * <div data-hud-band>…}` and vanished at the 1:00 cue. Measured in Electron at 1431×649: the
 * bottom inset fell from 98px to 73px on the unlock tick (owner report, 2026-09-18).
 *
 * SOURCE checks, like the rest of this lane: the rule is about the MARKUP, and the two things
 * that hold it are the row being unconditional and the slot being reserved in both axes (an
 * empty flex row measures 0 on one of them, and a zero-sized band is skipped).
 */
function hudBandChecks(check: Check): void {
  const hud = readFileSync(join(BIOBUZZ_DIR, 'HudSlots.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src', 'ui', 'styles.css'), 'utf8');
  check(
    'E1 HUD BAND: the BIOBUZZ cue row is rendered unconditionally (its CONTENTS come and go)',
    /\n      <div className="breakdown-row" data-hud-band>/.test(hud),
  );
  check(
    'E1 HUD BAND: no `data-hud-band` in HudSlots.tsx sits behind a `&& (` guard',
    !/&&\s*\(\s*\n\s*<div[^>]*data-hud-band/.test(hud),
  );
  const rule = css.slice(css.indexOf('\n.breakdown-row {'), css.indexOf('\n.breakdown-row span'));
  check(
    'E1 HUD BAND: `.breakdown-row` reserves its slot in BOTH axes, so an empty row is still measured',
    /min-height:\s*24px/.test(rule) && /min-width:\s*24px/.test(rule),
    rule.replace(/\s+/g, ' ').slice(0, 120),
  );
  const game = readFileSync(join(root, 'src', 'game.ts'), 'utf8');
  check(
    'E1 HUD BAND: within one layout the safe rect only ever shrinks (`hudInsetsEpoch`)',
    game.includes('hudInsetsEpoch') && /ins\.bottom = Math\.min\(Math\.max\(bottom, keep \? ins\.bottom : 0\)/.test(game),
  );

  /**
   * ⚠️ **A PARKED ELEMENT'S `z` CONVENTION BRANCHES ON THE PHYSICS, NEVER ON `state.kind`.**
   *
   * 3D writes a BOTTOM for every ball it solves, parked or loose: `readback` is `b.z = t.z - r`
   * and a placed flower element is seated `PLACE_CENTRE_Z - r`. 2D writes a CENTRE for a parked
   * one and only for a parked one: `play.ts`'s `park()` uses `CELL_MID_Z` and `flowerStackZ`
   * returns "Centre heights (in) of every element in the stack".
   *
   * Both mistakes have shipped, one per branch, and both came from keying on the KIND:
   *  · the HIVE branch drew a bare `b.z`, one radius LOW under 3D — visible on a landing shot,
   *    because it arrives tagged `flight` (drawn at `b.z + r`) and `derive.ts` retags it
   *    `element` the tick it settles (owner, 2026-09-19: "once balls land inside the HIVE, they
   *    teleport slightly downwards"). It was then fixed to lift ALWAYS, which floats the same
   *    element 1.4 in high under 2D;
   *  · the FLOWER branch drew raw ALWAYS, which sinks a 3D element a radius into its own stack.
   *
   * A 2D-physics world in the 3D VIEW is reachable — `GameView.tsx` falls back to
   * `practicePhysics: '2d'` on a 3D chunk-load failure without changing the view — so neither
   * branch may assume its own solve. These checks pin the branch itself; the FLOWER3D lane
   * asserts the 3D half numerically, against a real body.
   */
  {
    const els = readFileSync(join(root, 'src', 'games', 'biobuzz', 'scene', 'renderElements.ts'), 'utf8');
    const engine = readFileSync(join(root, 'src', 'games', 'biobuzz', 'sim3d', 'engineImpl.ts'), 'utf8');
    check(
      'the parked-element height is read off the PHYSICS, not off `state.kind`',
      /const bottom = biobuzzPhysics\(world\) === '3d';/.test(els),
    );
    check(
      'the HIVE branch lifts by the radius under 3D and draws raw under 2D',
      // `poseAtQuat` since the CAD elements landed: there is one pose now, because a perforated
      // ball parked in a cell still has to be drawn the way up it arrived. The HEIGHT rule this
      // check is about is unchanged.
      /poseAtQuat\(mesh, idx, b\.pos\.x \+ t \* span, b\.pos\.y, bottom \? b\.z \+ r : b\.z, spin\)/.test(els),
    );
    check(
      'the FLOWER branch takes the SAME branch, not the opposite one',
      /poseAtQuat\(mesh, idx, b\.pos\.x, b\.pos\.y, bottom \? b\.z \+ r : b\.z, spin\)/.test(els),
    );
    check(
      '...and 3D really does write a BOTTOM — `syncElement` places the body at `b.z + r`',
      /const centreZ = b\.z \+ r;/.test(engine) && /setTranslation\(b\.pos\.x, b\.pos\.y, centreZ\)/.test(engine),
    );
    check(
      '...while 2D really does write a CENTRE — `flowerStackZ` returns seat + r',
      /out\.push\(seat \+ r\);/.test(readFileSync(join(root, 'src', 'games', 'biobuzz', 'flower.ts'), 'utf8')),
    );
  }

  /**
   * ── THE HIVE'S PIVOT ROCKER RIDES THE TRAY ─────────────────────────────────────────────────
   *
   * Owner, 2026-09-20: "Support bracket for the hive is artifacting & is behind/desynced
   * sometimes (does not tip with the hive)." The six parts per alliance that bolt to the tray's
   * spine — the two Goal Pivot Bracket plates, the two damper holders and the two dampers — ship
   * inside `hive_<a>/frame`, which is STATIC, so they sat still while the see-saw swung. The
   * autopsy is in `renderFieldGlb.ts`'s own THE PIVOT ROCKER THE PIPELINE ALSO FILED AS FRAME.
   *
   * Two things are pinned here, because the bug needed both to be true to ship:
   *  · the SELECTOR still separates. A whole connected component that reaches no further than
   *    `ROCKER_HALF_SPAN_IN` from a tray's centreline plane is rocker hardware; measured, the six
   *    reach 0.60 in and the nearest STATIC component (`axle_holder` / `a_frame_top_corner`)
   *    reaches 2.26, on both LODs. A field revision that closes that gap fails here rather than
   *    silently freezing a part again — or silently tipping the A-frame.
   *  · the reparented geometry is RIGID on the tray. At every tilt its world position is the
   *    rotation about the pivot of where the CAD captured it. That is what "does not tip with
   *    the hive" failed at, by up to 7.28 in at the opposite rest and 0.00 at the captured one —
   *    the whole of the owner's "sometimes", because `|captureTheta|` IS `BB_HIVE_TILT_DEG`.
   */
  {
    const ROCKER_PER_ALLIANCE = 6;
    const SELECTOR_FLOOR_IN = 2.2; // the nearest STATIC component; measured 2.26
    const SELECTOR_CEIL_IN = 0.65; // the furthest ROCKER component; measured 0.60
    for (const [file, scene] of [
      ['field.glb', FIELD_GLB_SCENE],
      ['field-low.glb', FIELD_LOW_GLB_SCENE],
    ] as const) {
      check(`${file} parses, so the rocker checks below are not vacuous`, scene !== null);
      if (!scene) continue;
      const comps = hiveFrameComponents(scene);
      for (const a of ['red', 'blue'] as const) {
        const rides = comps.filter((c) => c.rides && c.alliance === a);
        check(
          `${file}: ${a}'s tray carries all ${ROCKER_PER_ALLIANCE} pivot-rocker parts (2 brackets, 2 damper holders, 2 dampers)`,
          rides.length === ROCKER_PER_ALLIANCE,
          `${rides.length}: ${rides.map((c) => `${c.tris}t@${c.spanFromPivot.toFixed(2)}`).join(' ')}`,
        );
        check(`${file}: ...and every one of them is real geometry`, rides.every((c) => c.tris > 0));
      }
      const worstRocker = Math.max(...comps.filter((c) => c.rides).map((c) => c.spanFromPivot));
      const nearestStatic = Math.min(...comps.filter((c) => !c.rides).map((c) => c.spanFromPivot));
      check(
        `${file}: the rocker/frame split has room to be wrong in — rocker reaches ${worstRocker.toFixed(2)} in, the nearest static ${nearestStatic.toFixed(2)}`,
        worstRocker <= SELECTOR_CEIL_IN && nearestStatic >= SELECTOR_FLOOR_IN,
        `${worstRocker.toFixed(3)} / ${nearestStatic.toFixed(3)}`,
      );
    }

    if (FIELD_LOW_GLB_SCENE) {
      const fg = assembleFieldGroups(FIELD_LOW_GLB_SCENE, 'low');
      check('the loader moves the braces AND the rocker off the static frame nodes', fg.braceTris > 0 && fg.rockerTris > 0, `${fg.braceTris} brace / ${fg.rockerTris} rocker tris`);
      // nothing rocker-shaped may be LEFT behind in a frame node, or half of it would still freeze
      const leftBehind = hiveFrameComponents(fg.root).filter((c) => c.rides);
      check(
        'nothing within the rocker span is left in a hive FRAME node after the reparent',
        leftBehind.length === 0,
        leftBehind.map((c) => `${c.node}:${c.tris}t`).join(', '),
      );
      for (const a of ['red', 'blue'] as const) {
        const tray = fg.hives[a].tray;
        const moved: THREE.Mesh[] = [];
        tray.traverse((o) => {
          if (o instanceof THREE.Mesh && /tray-(rocker|brace)$/.test(o.name)) moved.push(o);
        });
        check(`${a}: every reparented part hangs off the TILTING group, not the frame`, moved.length > 0, `${moved.length} meshes`);
        const pivot = fieldColliders3d().trays[a].pivot;
        // the reference pose is the one the CAD captured — the single tilt at which the frozen
        // rocker used to look right.
        const rest = cadCaptureTheta(a);
        const sample = (theta: number): THREE.Vector3[] => {
          tray.rotation.set(theta, 0, 0);
          tray.updateMatrixWorld(true);
          const out: THREE.Vector3[] = [];
          for (const m of moved) {
            const pos = m.geometry.getAttribute('position');
            const step = Math.max(1, Math.floor(pos.count / 40));
            for (let i = 0; i < pos.count; i += step) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
          }
          return out;
        };
        const at0 = sample(rest);
        let worst = 0;
        let spread = 0;
        for (const theta of [-0.5236, -0.2618, 0, 0.2618, 0.5236]) {
          const now = sample(theta);
          const rot = new THREE.Matrix4()
            .makeTranslation(pivot[0], pivot[1], pivot[2])
            .multiply(new THREE.Matrix4().makeRotationX(theta - rest))
            .multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
          for (let i = 0; i < now.length; i++) {
            const want = at0[i].clone().applyMatrix4(rot);
            worst = Math.max(worst, now[i].distanceTo(want));
            spread = Math.max(spread, now[i].distanceTo(at0[i]));
          }
        }
        check(`${a}: the rocker is RIGID on the tray — its pose at any tilt is the captured pose rotated about the pivot`, worst < 1e-3, `${worst.toFixed(5)} in`);
        check(`${a}: ...and it really does move (a frozen part would pass the line above trivially)`, spread > 6, `${spread.toFixed(2)} in over the full swing`);
        tray.rotation.set(rest, 0, 0);
      }
    }
  }

  // ── GROUND BEAM WINDING — owner report 2026-09-20: "the structural beams on the ground are
  // rendered as transparent on one side and opaque on the other." See `renderFieldGlb.ts`'s own
  // "THE GROUND BARS ARE WOUND INCONSISTENTLY" header for the full measurement this pins.
  //
  // ⚠️ ONLY `field.glb` (FIELD_GLB_SCENE) IS TOUCHED HERE. `assembleFieldGroups` mutates its
  // argument in place — reassigns resolved PBR materials over the glTF's `<finish>#<hex>` names,
  // replaces merged geometries with the post-extraction remainder — and a SECOND call on the same
  // object reads its own already-resolved material names back through `parseMaterialName`, which
  // rejects them and repaints everything grey (measured: every hive-frame mesh becomes
  // `__unrecognised__@hive_frame` and a `/groundbeam` mesh gets extracted a second, nested time).
  // `FIELD_LOW_GLB_SCENE` is already spent by the rocker block just above, so this block reads
  // `FIELD_GLB_SCENE` alone, RAW, before its own single `assembleFieldGroups` call.
  {
    const scene = FIELD_GLB_SCENE;
    check('field.glb parses, so the ground-beam checks below are not vacuous', scene !== null);
    if (scene) {
      // whole-COMPONENT z-band — see `GROUND_BEAM_MAX_Z` in renderFieldGlb.ts for why a
      // per-triangle test would slice the A-Frame Leg's own foot into this bucket.
      const GROUND_BEAM_MAX_Z_PIN = 3;
      const groundBeamByMesh = new Map<THREE.Mesh, number[]>();
      let anyGroundBeamComponent = false;
      for (const nodeName of HIVE_FRAME_NODES) {
        let node: THREE.Object3D | null = null;
        scene.traverse((o) => {
          if (node) return;
          if ((o.userData as { name?: string } | undefined)?.name === nodeName || o.name === nodeName) node = o;
        });
        if (!node) continue;
        (node as THREE.Object3D).traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const { ofTriangle, spans } = weldedComponents(o);
          const tris: number[] = [];
          for (const [id, s] of spans) {
            if (s.zMax > GROUND_BEAM_MAX_Z_PIN) continue;
            anyGroundBeamComponent = true;
            for (let t = 0; t < ofTriangle.length; t++) if (ofTriangle[t] === id) tris.push(t);
          }
          if (tris.length > 0) groundBeamByMesh.set(o, tris);
        });
      }
      check('field.glb: at least one ground-beam-band component exists in the raw asset', anyGroundBeamComponent);
      // PIN THE DEFECT, AS THE 2026-09-20 REPORT FOUND IT: every ground-beam component is a CLOSED
      // shell (0 boundary edges) that is not consistently wound. Still true, and still the right
      // thing to pin — what CHANGED on 2026-09-21 is that it is true of the whole field and not of
      // these three bars, so the `DoubleSide` extraction those two assertions used to guard is gone
      // and the block below asserts the general repair instead. See `renderFieldGlb.ts`'s "IT IS
      // NOT THE GROUND BARS" header.
      let worstDefective = 0;
      for (const [mesh, tris] of groundBeamByMesh) {
        const stats = shellWindingStats(mesh, tris);
        check(
          `field.glb: a ground-beam component on "${mesh.name}" is a closed shell (0 boundary edges)`,
          stats.boundaryEdges === 0,
          `${stats.boundaryEdges} boundary edges of ${stats.boundaryEdges + stats.flippedEdges + stats.okInteriorEdges + stats.nonManifoldEdges}`,
        );
        check(
          `field.glb: ...and it is NOT consistently wound (this is exactly what makes it defective)`,
          stats.flippedEdges > 0,
          `${stats.flippedEdges} flipped interior edges`,
        );
        if (stats.flippedEdges > 0) worstDefective++;
      }
      check('field.glb: the pinned defect actually applies to at least one mesh', worstDefective > 0);

      // NOW THE FIX: one single `assembleFieldGroups` call. The ground bars are no longer
      // `DoubleSide` — they are WOUND CORRECTLY, which is cheaper and right from both sides — so
      // what is asserted here is that nothing in a hive frame needs doubling at all any more.
      const fg = assembleFieldGroups(scene, 'low');
      check(
        'field.glb: the loader repaired ground-beam-era winding as part of the general pass',
        fg.winding.reversedTris > 0,
        `${fg.winding.reversedTris} of ${fg.winding.totalTris} triangles reversed`,
      );
      let doubleSidedTris = 0;
      let frontSidedTris = 0;
      for (const frame of [fg.hives.red.frame, fg.hives.blue.frame, fg.sharedFrame].filter((o): o is THREE.Object3D => !!o)) {
        frame.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const mat = Array.isArray(o.material) ? o.material[0] : o.material;
          const idx = o.geometry.getIndex();
          const tris = (idx ? idx.count : o.geometry.getAttribute('position').count) / 3;
          if (mat.side === THREE.DoubleSide) doubleSidedTris += tris;
          else frontSidedTris += tris;
        });
      }
      check(
        'field.glb: no hive-frame triangle is DoubleSide any more — the bars are wound right instead',
        doubleSidedTris === 0,
        `${doubleSidedTris} doubleSided vs ${frontSidedTris} frontSided`,
      );
      // 34,976 as measured — the frames' own total less the braces and the rocker, which
      // `reparentTrayBraces` has already moved onto the two trays by this point.
      check('field.glb: ...and the frames still have their triangles', frontSidedTris > 30000, String(frontSidedTris));
    }
  }

// ── THE WHOLE-FIELD WINDING REPAIR — owner report 2026-09-21: "a lot of mounting brackets,
// especially black and gray ones with complex geometry, have holes in them from different angles
// and they are glitchy and broken."
//
// `renderFieldGlb.ts`'s "IT IS NOT THE GROUND BARS" header carries the measurement: 193 of 193
// components of `field.glb` are closed shells with MIXED winding, ~49 % of every part's triangles
// wound inward, confirmed independently by ray parity. These blocks pin the DEFECT in the raw
// asset and the REPAIR in the assembled scene, for both LODs.
//
// ⚠️ EACH BLOCK PARSES ITS OWN SCENE. `assembleFieldGroups` mutates its argument in place, and
// `FIELD_GLB_SCENE` / `FIELD_LOW_GLB_SCENE` are both already spent by the blocks above — a second
// call on one reads its own resolved material names back through `parseMaterialName`, which
// rejects them and repaints the field grey.
{
  const raw = WIND_RAW_HIGH;
  check('bracket winding: field.glb re-parses for its own block', raw !== null);
  if (raw) {
    let comps = 0;
    let mixed = 0;
    let mixedTris = 0;
    let boundaryComps = 0;
    let totalTris = 0;
    raw.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const c of analyseMeshShells(o)) {
        comps++;
        totalTris += c.tris;
        if (c.boundaryEdges > 0) boundaryComps++;
        if (c.flippedEdges > 0) {
          mixed++;
          mixedTris += c.tris;
        }
      }
    });
    // THE DEFECT, stated as the owner's report measures: it is not three bars, it is everything.
    check(
      'bracket winding: the RAW field.glb is inconsistently wound across essentially every component',
      comps > 100 && mixed / comps > 0.9,
      `${mixed} of ${comps} components mixed, ${mixedTris} of ${totalTris} tris`,
    );
    // ...and it is NOT the open-sheeting defect `CLEAR_SHEETS_ARE_SINGLE_SIDED` named. Zero
    // boundary edges anywhere on the high LOD is what makes case (c) — reorient, stay FrontSide —
    // the right answer rather than a blanket DoubleSide.
    check(
      'bracket winding: ...and not one high-LOD component is genuinely OPEN (no boundary edges at all)',
      boundaryComps === 0,
      `${boundaryComps} components with a boundary edge`,
    );
  }
}

{
  // THE REPAIR, on the HIGH LOD. The load-bearing claim: after `assembleFieldGroups`, no mesh that
  // renders single-sided still has a component with a flipped interior edge or an inward-facing
  // shell — which is the whole of "holes from different angles", stated as a measurement.
  const scene = WIND_FIX_HIGH;
  check('bracket winding: field.glb parses for the repair block', scene !== null);
  if (scene) {
    const fg = assembleFieldGroups(scene, 'low');
    check('bracket winding: the pass ran over the whole field, not one node', fg.winding.meshes > 20, String(fg.winding.meshes));
    check(
      'bracket winding: about half of every part was wound inward and got reversed',
      fg.winding.reversedTris / fg.winding.totalTris > 0.3 && fg.winding.reversedTris / fg.winding.totalTris < 0.7,
      `${fg.winding.reversedTris} of ${fg.winding.totalTris}`,
    );
    check(
      'bracket winding: every shell was orientable — nothing here is a genuine modelling error',
      fg.winding.nonOrientableIslands === 0,
      String(fg.winding.nonOrientableIslands),
    );
    // HIGH LOD: no component is open, so not one triangle moves off FrontSide. The draw cost of
    // the fix is zero here, and the 6,690 triangles the ground-beam patch used to double are back
    // on the cheap path.
    check('bracket winding: field.glb needs NO DoubleSide at all', fg.winding.openTris === 0, String(fg.winding.openTris));

    let frontTris = 0;
    let doubleTris = 0;
    let clearTris = 0;
    let stillBroken = 0;
    let worst = '';
    const meshes: THREE.Mesh[] = [];
    fg.root.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    for (const o of meshes) {
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
      const idx = o.geometry.getIndex();
      const tris = Math.floor((idx ? idx.count : o.geometry.getAttribute('position').count) / 3);
      if (mat.transparent) {
        clearTris += tris;
        continue;
      }
      if (mat.side === THREE.DoubleSide) {
        doubleTris += tris;
        check(
          `bracket winding: the DoubleSide mesh "${o.name}" is an OPEN-shell split, never a clear panel`,
          o.userData.bbDoubleSided === true && mat.transparent !== true,
        );
        continue;
      }
      frontTris += tris;
      for (const c of analyseMeshShells(o)) {
        if (c.flippedEdges === 0 && (c.signedVolume >= 0 || c.open)) continue;
        stillBroken++;
        if (!worst) worst = `${o.name} tris=${c.tris} flipped=${c.flippedEdges} vol=${c.signedVolume.toFixed(2)}`;
      }
    }
    check(
      'bracket winding: NO single-sided component is left with inverted or mixed winding',
      stillBroken === 0,
      stillBroken === 0 ? `${frontTris} FrontSide triangles all consistent` : `${stillBroken} still broken, e.g. ${worst}`,
    );
    check('bracket winding: ...and the correct shells stayed FrontSide rather than being blanket-doubled', doubleTris === 0 && frontTris > 200000, `${frontTris} front / ${doubleTris} double`);
    check('bracket winding: the clear panels are still their own transparent surface', clearTris > 10000, String(clearTris));
  }
}

{
  // THE CLEAR PANELS ARE UNTOUCHED, byte for byte. Their look is four measured tuning passes deep
  // (the dielectric header) and every number in it was fitted against the asset AS IT SHIPS, so a
  // winding repair under them would quietly halve the layer count the veil was sized for. This
  // compares each clear-panel mesh's index buffer in the assembled scene against a FRESH parse.
  const scene = WIND_CLEAR_HIGH;
  const pristine = WIND_PRISTINE_HIGH;
  check('clear panels: both parses succeeded', scene !== null && pristine !== null);
  if (scene && pristine) {
    // ⚠️ DIGEST THE CORNER POSITIONS IN ORDER, NOT THE INDEX. `styleScene`'s
    // `computeCreasedNormals` splits a vertex into one copy per distinct normal and rewrites the
    // index accordingly (`walls glass#e6e6e6` goes 1,642 verts -> 4,455), so an index digest moves
    // on every mesh whether its winding was touched or not. The corner POSITIONS in triangle order
    // are invariant under that split and flip the moment a triangle is reversed, which is exactly
    // the property being asserted.
    const windingOf = (root: THREE.Object3D, transparentOnly: boolean): Map<string, string> => {
      const out = new Map<string, string>();
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
        const glb = (mat.name ?? '').split('@')[0];
        const isClear = glb.startsWith('glass#') || glb === 'plastic#e6e6e6';
        if (transparentOnly ? !mat.transparent : !isClear) return;
        const idx = o.geometry.getIndex();
        const pos = o.geometry.getAttribute('position');
        if (!idx || !pos) return;
        let h = 0;
        for (let i = 0; i < idx.count; i++) {
          const v = idx.getX(i);
          for (const c of [pos.getX(v), pos.getY(v), pos.getZ(v)]) h = (h * 31 + Math.round(c * 4096)) % 2147483647;
        }
        const path = `${((o.parent?.userData as { name?: string } | undefined)?.name ?? o.parent?.name ?? '?')}/${glb}`;
        out.set(path, `${idx.count}:${h}`);
      });
      return out;
    };
    const before = windingOf(pristine, false);
    const fg = assembleFieldGroups(scene, 'low');
    const after = windingOf(fg.root, true);
    // three, and exactly three: the perimeter `glass#e6e6e6` and one `plastic#e6e6e6` cell-skin
    // mesh per tray. The `hive_shared/frame` mesh carries the SAME glTF material name and is the
    // opaque ACM board — see `isClearPanel`, which is why that rule is keyed on the node too.
    check('clear panels: the assembled scene still has its three transparent panel meshes', after.size === 3, String(after.size));
    let compared = 0;
    let changed = 0;
    for (const [path, digest] of after) {
      const was = before.get(path);
      if (was === undefined) continue;
      compared++;
      if (was !== digest) changed++;
    }
    check('clear panels: their winding is BYTE-IDENTICAL to the raw asset (the repair skipped them)', compared === 3 && changed === 0, `${compared} compared, ${changed} changed`);
    // ...and the control that says the digest can actually see a change: the ACM panel shares the
    // `plastic#e6e6e6` name, is NOT clear, and therefore IS repaired.
    const acmPath = 'hive_shared/frame/plastic#e6e6e6';
    const acmAfter = windingOf(fg.root, false).get(acmPath);
    check(
      'clear panels: ...and the same digest DOES move on the opaque ACM board, so the check is not vacuous',
      acmAfter !== undefined && before.get(acmPath) !== undefined && acmAfter !== before.get(acmPath),
      `${before.get(acmPath)} -> ${acmAfter}`,
    );
    check(
      'clear panels: ...and the winding pass counted them as skipped rather than silently missing them',
      fg.winding.clearPanelTris > 10000,
      String(fg.winding.clearPanelTris),
    );
    let clearDouble = 0;
    fg.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
      if (mat.transparent && mat.side === THREE.DoubleSide) clearDouble++;
    });
    check('clear panels: still DoubleSide, as CLEAR_SHEETS_ARE_SINGLE_SIDED decided', clearDouble === 3, String(clearDouble));
  }
}

{
  // THE LOW LOD is the only place `DoubleSide` is used at all: the simplifier opens real holes in
  // the small parts, and a component with no closed inside has no outward to orient it to. This
  // pins that the split is SCOPED — a small minority, the rest single-sided and consistent.
  const scene = WIND_FIX_LOW;
  check('bracket winding: field-low.glb parses for its own block', scene !== null);
  if (scene) {
    const fg = assembleFieldGroups(scene, 'low');
    check('bracket winding (low): the pass ran', fg.winding.meshes > 20 && fg.winding.reversedTris > 0, `${fg.winding.meshes} meshes, ${fg.winding.reversedTris} reversed`);
    check('bracket winding (low): the decimator DOES open real holes, so the DoubleSide path is live', fg.winding.openComponents > 0 && fg.winding.openTris > 0, `${fg.winding.openComponents} comps / ${fg.winding.openTris} tris`);
    let frontTris = 0;
    let doubleTris = 0;
    let stillBroken = 0;
    let splitMeshes = 0;
    const meshes: THREE.Mesh[] = [];
    fg.root.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    for (const o of meshes) {
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
      const idx = o.geometry.getIndex();
      const tris = Math.floor((idx ? idx.count : o.geometry.getAttribute('position').count) / 3);
      if (mat.transparent) continue;
      if (o.userData.bbDoubleSided) {
        splitMeshes++;
        doubleTris += tris;
        check(`bracket winding (low): the split mesh "${o.name}" renders DoubleSide`, mat.side === THREE.DoubleSide, `side=${mat.side}`);
        check(`bracket winding (low): ...and stayed OPAQUE — a structural part is never routed through the clear-panel material`, mat.transparent !== true);
        continue;
      }
      check(`bracket winding (low): "${o.name}" was not blanket-doubled`, mat.side !== THREE.DoubleSide, `side=${mat.side}`);
      frontTris += tris;
      for (const c of analyseMeshShells(o)) {
        if (c.flippedEdges === 0 && (c.signedVolume >= 0 || c.open)) continue;
        stillBroken++;
      }
    }
    check('bracket winding (low): at least one open shell was actually split out', splitMeshes > 0, String(splitMeshes));
    check('bracket winding (low): NO single-sided component is left inverted or mixed', stillBroken === 0, String(stillBroken));
    check(
      'bracket winding (low): the DoubleSide share stays a small minority (scoped, not blanket)',
      doubleTris > 0 && doubleTris < frontTris * 0.15,
      `${doubleTris} double vs ${frontTris} front`,
    );
  }
}

  /**
   * ── THE PERFORATED SCORING ELEMENTS ────────────────────────────────────────────────────────
   *
   * Owner, 2026-09-21: "For higher graphics settings, model the balls accurately with the holes.
   * Consider grabbing the actual accurate cad."
   *
   * `public/models/biobuzz/elements.glb` is a REAL CAD EXTRACTION, not a model by eye: one
   * `am-5851: Pollen` and one `am-5852: Blue Nectar` solid out of the SAME sha-pinned field STEP
   * `convert.py` reads and deliberately drops (`RE_ELEMENT`), through
   * `scripts/field-cad/elements.py` + `elements.mjs` (`npm run element-cad`). These checks are
   * what stop the asset and the game drifting apart: the CAD's own radius against the SIM's
   * constant, the triangle budget a full field is drawn against, and the winding, which on a
   * ball that is LOOKED THROUGH is the difference between a hole and a hole-shaped hole in the
   * ball behind it.
   */
  {
    check('elements.glb: the shipped asset decodes', ELEMENTS_GLB_SCENE !== null);
    if (ELEMENTS_GLB_SCENE) {
      const byName = new Map<string, THREE.Mesh>();
      ELEMENTS_GLB_SCENE.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) byName.set(String(o.userData?.name ?? o.name), o as THREE.Mesh);
      });
      check('elements.glb: it carries exactly the two element meshes', byName.size === 2 && byName.has('pollen') && byName.has('nectar'), [...byName.keys()].join(','));

      // PER BALL. A match has up to ~100 elements on screen across the two `InstancedMesh`es,
      // drawn again in the sun's depth pass on High/Ultra — this is the number the tessellation
      // deflection in `elements.mjs` is chosen against, and it is a ratchet.
      const TRI_BUDGET = 3000;
      for (const [kind, expectedR] of [['pollen', BB_POLLEN_R] as const, ['nectar', BB_NECTAR_R] as const]) {
        const mesh = byName.get(kind);
        if (!mesh) continue;
        mesh.updateWorldMatrix(true, false);
        const geo = mesh.geometry;
        const pos = geo.getAttribute('position');
        const idx = geo.getIndex();
        const tris = (idx ? idx.count : pos.count) / 3;
        check(`elements.glb: ${kind} is inside the ${TRI_BUDGET}-triangle budget`, tris > 0 && tris <= TRI_BUDGET, `${tris} tris`);

        // ⚠️ `getX/getY/getZ`, NEVER `geometry.applyMatrix4`: `meshopt` stores POSITION as a
        // NORMALIZED Int16 (`KHR_mesh_quantization`) and `applyMatrix4` writes floats straight
        // back into that Int16 array. Measured on this very asset, doing it the obvious way
        // turned two clean shells at r 1.33/1.40 into a smear of radii from 0.60 to 1.40 — a
        // convincing-looking failure that has nothing to do with the CAD.
        const v = new THREE.Vector3();
        let rmax = 0;
        let rmin = Infinity;
        for (let i = 0; i < pos.count; i++) {
          v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
          rmax = Math.max(rmax, v.length());
          rmin = Math.min(rmin, v.length());
        }
        check(
          `elements.glb: ${kind}'s outer radius matches its config constant to ${ELEMENT_RADIUS_TOL_IN} in`,
          Math.abs(rmax - expectedR) <= ELEMENT_RADIUS_TOL_IN,
          `CAD ${rmax.toFixed(4)} vs config ${expectedR}`,
        );
        // IT IS A SHELL, NOT A BALL. Every vertex is on one of the two spheres or on a bore wall
        // between them, so the closest one to the centre is the inner sphere — proof the
        // extraction kept the cavity the holes look into, rather than a solid the bores dimpled.
        check(`elements.glb: ${kind} is hollow — its innermost vertex is well inside its outer radius`, rmin < rmax * 0.99, `inner ${rmin.toFixed(4)}, outer ${rmax.toFixed(4)}`);

        // ── WINDING. One closed, consistently-wound, outward-facing shell ──────────────────
        // This is the check the whole asset turns on. A holed ball is seen THROUGH its holes, so
        // the inner sphere and all 26 bore walls face the camera; if `elements.py`'s
        // `TopAbs_REVERSED` flip were missing or inverted, those would be back-faces and every
        // hole would show the ball's far wall or nothing at all. `field.glb` HAS this defect on
        // its ground bars (`fixGroundBeamWinding`) — this asset must not.
        const comps = analyseMeshShells(mesh);
        check(`elements.glb: ${kind} is ONE connected component`, comps.length === 1, `${comps.length}`);
        const all: number[] = [];
        for (let t = 0; t < tris; t++) all.push(t);
        const stats = shellWindingStats(mesh, all);
        check(`elements.glb: ${kind} is a CLOSED shell (no boundary edges)`, stats.boundaryEdges === 0, `${stats.boundaryEdges}`);
        check(
          `elements.glb: ${kind} is CONSISTENTLY wound, so no component needs DoubleSide`,
          stats.flippedEdges === 0 && stats.nonManifoldEdges === 0,
          `${stats.flippedEdges} flipped, ${stats.nonManifoldEdges} non-manifold`,
        );
        // ...and wound OUTWARD, not inward: a consistently-wound shell facing the wrong way would
        // pass every test above and render inside-out. The divergence-theorem volume is positive
        // for outward and negative for inward, and its MAGNITUDE separates a shell from a solid.
        const solid = (4 / 3) * Math.PI * expectedR ** 3;
        check(
          `elements.glb: ${kind} faces OUTWARD and encloses a shell, not a solid`,
          stats.signedVolume > 0 && stats.signedVolume < solid * 0.35,
          `vol ${stats.signedVolume.toFixed(3)} in3 against a solid's ${solid.toFixed(3)}`,
        );
      }

      // THE CAD'S OWN NUMBERS SHIP BESIDE THE MESH. `elements.py` measures them off the B-rep
      // (analytic sphere/cylinder faces), not off a triangulation, so this file is the record of
      // what the CAD says — including the one place it disagrees with `config.ts`.
      const meas = JSON.parse(
        readFileSync(join(root, 'public', 'models', 'biobuzz', 'elements-measurements.json'), 'utf8'),
      ) as Record<string, { boreCount: number; configDeltaIn: number; wallIn: number; boreDiameterIn: number }>;
      check('elements-measurements.json: both kinds are 26-bore balls', meas.pollen?.boreCount === 26 && meas.nectar?.boreCount === 26);
      check('elements-measurements.json: POLLEN agrees with BB_POLLEN_R exactly', meas.pollen?.configDeltaIn === 0, `${meas.pollen?.configDeltaIn}`);
      // ⚠️ NOT A BUG, AND NOT TO BE "FIXED" HERE. The CAD says NECTAR is r 1.810 and `config.ts`
      // says 1.800. The CAD is authoritative for DIMENSIONS (owner ruling 2026-09-18) but this
      // radius is also the sphere Rapier solves and the number every flower/hive/intake tolerance
      // was measured against, so moving it is a SIM change the owner decides. The delta is pinned
      // here so it cannot drift further unnoticed while it waits.
      check(
        'elements-measurements.json: the NECTAR disagreement is still the known 0.010 in, and no larger',
        Math.abs((meas.nectar?.configDeltaIn ?? 1) - 0.01) < 1e-9,
        `${meas.nectar?.configDeltaIn}`,
      );
    }
  }

  /**
   * ── THE TIER GATE, AND THE SPHERE THAT ALWAYS STANDS ───────────────────────────────────────
   *
   * `elementDetail` is the seventeenth setting and it is NOT `meshDetail`: that one is already
   * `high` on Medium, and 100 perforated balls plus 100 more shadow casters is exactly what the
   * Medium column exists to avoid. Sphere / sphere / CAD / CAD.
   */
  {
    check('Low and Medium keep the cheap sphere', GFX_PRESETS.low.elementDetail === 'sphere' && GFX_PRESETS.medium.elementDetail === 'sphere');
    check('High and Ultra get the CAD ball', GFX_PRESETS.high.elementDetail === 'cad' && GFX_PRESETS.ultra.elementDetail === 'cad');
    // THE REPLAY EXPORT runs at a FIXED High (`SceneOptions.quality`, plan §4.7) and reads its
    // settings straight out of that column, so it inherits the accurate balls with no branch of
    // its own — this is the assertion that keeps that true if the column ever moves.
    check('the fixed-tier export column carries the CAD ball', GFX_PRESETS.high.elementDetail === 'cad');
    check('a junk stored value falls back to the tier column', coerceGraphicsSettings({ elementDetail: 'holes' }, GFX_PRESETS.high).elementDetail === 'cad');
    check('a stored pick survives coercion', coerceGraphicsSettings({ elementDetail: 'sphere' }, GFX_PRESETS.high).elementDetail === 'sphere');
    check('...and a blob written before this row existed keeps the rest of its settings', coerceGraphicsSettings({ shadows: 'off' }, GFX_PRESETS.ultra).elementDetail === 'cad');
    check('the row is part of the preset identity, so picking it makes the preset honest', !matchesPreset({ ...GFX_PRESETS.high, elementDetail: 'sphere' }, 'high'));

    const elSrc = readFileSync(join(SCENE_DIR, 'renderElements.ts'), 'utf8');
    const glbSrc2 = readFileSync(join(SCENE_DIR, 'renderElementsGlb.ts'), 'utf8');
    const sceneSrc = readFileSync(join(SCENE_DIR, 'renderScene.ts'), 'utf8');
    check(
      'the spheres are built first and unconditionally, so a scene never waits on the asset',
      /export function buildBiobuzzElements\(detail: ElementDetail = 'sphere'\)/.test(elSrc) && /sphereGeo: \{ pollen: pollenGeo, nectar: nectarGeo \}/.test(elSrc),
    );
    check('a CAD load failure warns and leaves the spheres, it does not throw', /console\.warn\([^)]*stay smooth spheres/.test(elSrc));
    check('the arriving asset re-reads the INTENT, so a pick made during the fetch wins', /const geo = els\.detail === 'cad' && els\.cadGeo \? els\.cadGeo : els\.sphereGeo;/.test(elSrc));
    check('the scene applies the row live, beside the other element setting', /setElementDetail\(this\.elements, s\.elementDetail\);/.test(sceneSrc));
    check('...and the scene factory pre-warms the asset with the field so an export never draws a sphere', /loadElementGeometries\(\)\.catch\(\(\) => null\) : null,/.test(sceneSrc));
    check('the loader refuses a mesh whose radius is not the config constant', /outer radius \$\{rmax\.toFixed\(4\)\} in is not/.test(glbSrc2));
    // ONE RADIUS (owner, 2026-09-21: "Keep the sim ... As long as it is consistent"): the CAD
    // NECTAR is 1.810 in and the sim solves 1.800, so the loader fits the accepted mesh onto the
    // config constant — the perforated ball, the sphere fallback and the solved body are one size.
    check(
      'the loader draws every element at exactly the radius the sim solves (fits the mesh onto the config constant)',
      /const fit = expectedR \/ rmax;/.test(glbSrc2) && /out\[i\] \*= fit;/.test(glbSrc2),
    );
    check('the loader never applyMatrix4s the quantized attribute', !/geo\.applyMatrix4\(/.test(glbSrc2) && /pos\.getX\(i\), pos\.getY\(i\), pos\.getZ\(i\)/.test(glbSrc2));
    check('nothing is drawn DoubleSide — the CAD winding is what makes the holes read', !/THREE\.DoubleSide/.test(elSrc) && !/THREE\.DoubleSide/.test(glbSrc2));
    check('only what exists is drawn (the instance count is the live one, not the cap)', /els\.pollen\.count = pollenN;/.test(elSrc) && /els\.nectar\.count = nectarN;/.test(elSrc));

    // THE CHUNK BOUNDARY, re-asserted for the file this row was added to: `graphics/` is read by
    // `ui/GraphicsSection.tsx` and `src/contributors.ts`, both ordinary main-bundle files.
    const settingsSrc = readFileSync(join(BIOBUZZ_DIR, 'graphics', 'settings.ts'), 'utf8');
    check("graphics/settings.ts still imports neither `three` nor anything under `scene/`", !/from '[^']*\bthree\b/.test(settingsSrc) && !/from '[^']*\/scene\//.test(settingsSrc));
  }

  /**
   * ── ROLLING WITHOUT SLIPPING, FROM DISPLACEMENT ────────────────────────────────────────────
   *
   * A holed ball that slides without turning reads as wrong the instant a hole is visible, and
   * the sim keeps NO orientation for an element (`Artifact` is pos/vel/z/vz — a per-tick
   * quaternion on 56 balls is egress nobody asked for). So the renderer integrates one, from the
   * displacement between two DRAWN frames rather than from `v · SIM_DT`: that is exact at any
   * frame rate, through snapshot interpolation, and on a frame the sim did not step.
   *
   * Driven through the real `updateBiobuzzElements` against a real `World`, not against a belief
   * about it — the two failure modes this has to rule out (a teleport spinning the ball through
   * tens of radians, a rewind spinning every ball at once) are both things the per-frame loop
   * does, not things the helper does.
   */
  {
    const angleOf = (a: THREE.Quaternion, b: THREE.Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
    const mkBall = (id: number) => ({
      id,
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
      r: BB_POLLEN_R,
      color: 'yellow',
      state: { kind: 'ground' },
    });
    const seat = (b: unknown, w: World): void => {
      w.balls.length = 0;
      (w.balls as unknown[]).push(b);
    };

    const w = createBiobuzzWorld('free', 5, []);
    const ball = mkBall(7);
    seat(ball, w);
    const els = buildBiobuzzElements('sphere');

    // frame one only ESTABLISHES a position: there is no previous frame to have rolled from.
    updateBiobuzzElements(els, w);
    const seeded = els.spin.get(7)!.q.clone();
    check('a ball is seeded with an orientation of its own, not the identity', angleOf(seeded, new THREE.Quaternion()) > 1e-3);

    // A STRAIGHT ROLL: 3 in of travel on a 1.4-in ball is 3/1.4 rad about the axis perpendicular
    // to travel. Two frames, because one frame is only a position.
    const ROLL = 3;
    ball.pos.x = ROLL;
    w.tick += 1;
    updateBiobuzzElements(els, w);
    const rolled = els.spin.get(7)!.q.clone();
    check(
      'a straight roll turns distance / r radians',
      Math.abs(angleOf(seeded, rolled) - ROLL / BB_POLLEN_R) < 1e-6,
      `${angleOf(seeded, rolled).toFixed(6)} vs ${(ROLL / BB_POLLEN_R).toFixed(6)}`,
    );
    // ...about `up × travel`, which for travel along +x is +y. The opposite sign is the classic
    // way a rolling ball reads as skidding.
    const delta = rolled.clone().multiply(seeded.clone().invert()).normalize();
    const axis = new THREE.Vector3(delta.x, delta.y, delta.z).normalize();
    check(
      '...about the axis horizontal-perpendicular to travel, in the rolling sense',
      axis.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-4,
      axis.toArray().map((n) => n.toFixed(4)).join(','),
    );

    // HALVING THE STEP AND TAKING TWO OF THEM IS THE SAME TOTAL — the whole point of integrating
    // displacement rather than a velocity times a fixed timestep. A renderer running at twice the
    // rate must not spin the ball twice as fast.
    {
      const els2 = buildBiobuzzElements('sphere');
      const w2 = createBiobuzzWorld('free', 5, []);
      const b2 = mkBall(7);
      seat(b2, w2);
      updateBiobuzzElements(els2, w2);
      const start = els2.spin.get(7)!.q.clone();
      for (let i = 1; i <= 2; i++) {
        b2.pos.x = (ROLL * i) / 2;
        w2.tick += 1;
        updateBiobuzzElements(els2, w2);
      }
      check('two half-steps roll exactly as far as one whole one', Math.abs(angleOf(start, els2.spin.get(7)!.q) - ROLL / BB_POLLEN_R) < 1e-6);
    }

    // A TELEPORT IS NOT TRAVEL. `derive.ts` re-tags a landed element at a hive cell's own
    // position, `park()` moves it to a cell centre, a capture takes it off the field. Integrating
    // `d / r` across one of those spins the ball through tens of radians in a single frame.
    const beforeJump = els.spin.get(7)!.q.clone();
    ball.pos.x = ROLL + 60;
    w.tick += 1;
    updateBiobuzzElements(els, w);
    check('a teleport does not spin the ball at all', angleOf(beforeJump, els.spin.get(7)!.q) < 1e-6);
    // ...and it RECORDS the new position, so the next real frame rolls from there rather than
    // replaying the jump.
    ball.pos.x = ROLL + 61;
    w.tick += 1;
    updateBiobuzzElements(els, w);
    check('...and the frame after a teleport rolls normally from the new position', Math.abs(angleOf(beforeJump, els.spin.get(7)!.q) - 1 / BB_POLLEN_R) < 1e-6);

    // A REWIND moves every ball at once and none of them rolled to get there.
    const beforeRewind = els.spin.get(7)!.q.clone();
    ball.pos.x = 1;
    w.tick = 0;
    updateBiobuzzElements(els, w);
    check('a rewind spins nothing', angleOf(beforeRewind, els.spin.get(7)!.q) < 1e-6);

    // A HELD BALL KEEPS ITS ORIENTATION AND ITS ENTRY. It is hidden while held, so the point is
    // the RELEASE: the frame it comes back it must roll from where it actually is, and it must
    // not snap its whole hole pattern back to the identity on the way through.
    w.tick = 100;
    ball.pos.x = 0;
    updateBiobuzzElements(els, w);
    const beforeHeld = els.spin.get(7)!.q.clone();
    (ball as { state: unknown }).state = { kind: 'held', robot: 0 };
    for (let i = 0; i < 5; i++) {
      ball.pos.x = i * 10;
      w.tick += 1;
      updateBiobuzzElements(els, w);
    }
    check('a held ball is tracked but never rolled', angleOf(beforeHeld, els.spin.get(7)!.q) < 1e-6);
    check('...and it keeps its entry rather than being pruned back to a fresh orientation', els.spin.has(7));
    (ball as { state: unknown }).state = { kind: 'ground' };
    ball.pos.x = 42;
    w.tick += 1;
    updateBiobuzzElements(els, w);
    check('...so its release is a continuation, rolling only the 2 in it has actually moved', Math.abs(angleOf(beforeHeld, els.spin.get(7)!.q) - 2 / BB_POLLEN_R) < 1e-6);

    // AND A BALL THAT LEAVES THE WORLD IS PRUNED, so a long session does not grow the map.
    w.balls.length = 0;
    w.tick += 1;
    updateBiobuzzElements(els, w);
    check('an id that has left `world.balls` is dropped', els.spin.size === 0);

    // TWO BALLS DO NOT SHOW THE SAME FACE. 40 POLLEN spawn with no orientation of their own, and
    // seeding them all identically is exactly as wrong-looking as not turning them at all.
    const faces = new Set<string>();
    for (let id = 0; id < 40; id++) {
      const e = buildBiobuzzElements('sphere');
      const ww = createBiobuzzWorld('free', 5, []);
      seat(mkBall(id), ww);
      updateBiobuzzElements(e, ww);
      const q = e.spin.get(id)!.q;
      faces.add([q.x, q.y, q.z, q.w].map((n) => n.toFixed(5)).join(','));
    }
    check('40 freshly spawned POLLEN show 40 different faces', faces.size === 40, `${faces.size}`);

    // AND THE DETAIL SWITCH IS A GEOMETRY SWAP, WITH THE SPHERE AS THE STANDING ANSWER. Node has
    // no `fetch` for a relative URL, so `cad` here exercises exactly the failure path a player
    // offline sees: the pick is remembered, the spheres stay on screen, nothing throws.
    const swap = buildBiobuzzElements('sphere');
    check('a sphere build draws the sphere geometry', swap.pollen.geometry === swap.sphereGeo.pollen && swap.nectar.geometry === swap.sphereGeo.nectar);
    setElementDetail(swap, 'cad');
    check('asking for CAD before the asset exists keeps the sphere on screen', swap.detail === 'cad' && swap.pollen.geometry === swap.sphereGeo.pollen);
    setElementDetail(swap, 'sphere');
    check('...and switching back is the same two assignments', swap.detail === 'sphere' && swap.pollen.geometry === swap.sphereGeo.pollen);
  }
}

/**
 * THE 3D BACKGROUND CHOICES AND THE 3D FLOWER READ-OUT (owner, 2026-09-21, two requests in one
 * session: "Add more choices for the 3d field background" and "for the top down view of the 3d
 * render, add a separate thing (like the 2d display) that shows inside the flower").
 *
 * Its own function rather than more blocks on the end of another one: both halves are about what
 * a player SEES rather than about a mesh or a collider, and the environment half is the only
 * place in this lane where a rendered-pixel measurement (`scratch/envshots.cjs`) is what set the
 * bounds being asserted.
 */
function environmentAndReadoutChecks(check: Check): void {
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // THE ENVIRONMENT LIST (owner, 2026-09-21: "Add more choices for the 3d field background").
  //
  // Eight PAINTED domes joined the two fetched HDRIs and the procedural room. Every check here
  // is a rule the eight had to be tuned INTO rather than a transcription of what they ended up
  // at — the measurements behind the bounds are in `graphics/environments.ts`'s own comments and
  // in that session's report (rendered-pixel contrast, per environment, off real captures).
  // ─────────────────────────────────────────────────────────────────────────────────────────
  {
    check(
      'the settings allowlist and the picker list are the SAME ids in the SAME order',
      ENVIRONMENT_IDS.length === BB_ENVIRONMENT_IDS.length &&
        ENVIRONMENT_IDS.every((id, i) => id === BB_ENVIRONMENT_IDS[i]),
      `${ENVIRONMENT_IDS.join(',')} vs ${BB_ENVIRONMENT_IDS.join(',')}`,
    );
    check('every id resolves to a def with that id', BB_ENVIRONMENTS.every((e) => environmentDef(e.id) === e));
    check(
      'the list grew to eleven and the room is still first',
      BB_ENVIRONMENTS.length === 11 && BB_ENVIRONMENTS[0].id === 'room',
      String(BB_ENVIRONMENTS.length),
    );

    // COERCION, both directions. A stored id this build still knows survives; anything else falls
    // back to the TIER's own column, never to a whole-object reset (`settings.ts`'s field-by-field
    // rule) — which is what a REMOVED environment would take on an older device.
    for (const id of ENVIRONMENT_IDS) {
      check(
        `${id}: a stored pick round-trips`,
        coerceGraphicsSettings({ environment: id }, GFX_PRESETS.medium).environment === id,
      );
    }
    for (const junk of ['school_hall', 'gym-01', '', null, 7, {}] as unknown[]) {
      check(
        `an unknown stored environment (${JSON.stringify(junk)}) falls back to the tier column`,
        coerceGraphicsSettings({ environment: junk }, GFX_PRESETS.high).environment === GFX_PRESETS.high.environment,
      );
    }
    check('an unknown id still resolves to the room rather than throwing', environmentDef('nope' as EnvironmentId).id === 'room');

    // COPY (`docs/ui-standard.md` §8) — a label, and a note that says what this place DOES to the
    // picture rather than repeating its own name.
    for (const e of BB_ENVIRONMENTS) {
      const firstWord = e.note.split(' ')[0];
      check(
        `${e.id}: sentence-case copy that does not restate its label`,
        e.name.length > 2 &&
          e.name[0] === e.name[0].toUpperCase() &&
          e.note.length > 4 &&
          !/[.]$/.test(e.note) &&
          firstWord === firstWord[0].toUpperCase() + firstWord.slice(1) &&
          !e.note.toLowerCase().includes(e.name.toLowerCase()),
        `${e.name} / ${e.note}`,
      );
    }

    // ONE RIG PER ENVIRONMENT, AND `BASE_RIG` IS renderCore's OWN NUMBERS. `graphics/` may not
    // import anything under `scene/` (the boundary check below), so the copy is verified by
    // reading the constants out of the renderer's source — the same technique the lane already
    // uses for the light-rig check.
    {
      const core = readFileSync(join(SCENE_DIR, 'renderCore.ts'), 'utf8');
      const num = (name: string): number => Number(new RegExp(`export const ${name} = ([0-9.]+)`).exec(core)?.[1]);
      const hexc = (name: string): number => Number(new RegExp(`export const ${name} = (0x[0-9a-f]+)`).exec(core)?.[1]);
      check(
        'BASE_RIG is renderCore.ts’s shared light rig, value for value',
        BASE_RIG.hemiSky === hexc('SCENE_HEMI_SKY') &&
          BASE_RIG.hemiGround === hexc('SCENE_HEMI_GROUND') &&
          BASE_RIG.hemiIbl === num('SCENE_HEMI_INTENSITY') &&
          BASE_RIG.hemiNoIbl === num('SCENE_HEMI_INTENSITY_NO_IBL') &&
          BASE_RIG.sunIntensity === num('SCENE_SUN_INTENSITY') &&
          BASE_RIG.exposure === num('SCENE_EXPOSURE'),
        JSON.stringify(BASE_RIG),
      );
      check(
        'the three environments that predate the rigs carry BASE_RIG unchanged',
        (['room', 'school-hall', 'monochrome-studio'] as const).every((id) => environmentDef(id).rig === BASE_RIG),
      );
    }

    // THE LEGIBILITY BOUNDS. Gameplay beats mood: the alliance colours, the yellow POLLEN and the
    // blue NECTAR are drawn at CONSTANTS, so the lighting is the only thing that can push them out
    // of their pairs, and each of these bounds is one way that happened during the tuning.
    const chanOf = (hex: number): number[] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    /** a BRIGHT colour's cast, as the ratio of its widest to its narrowest channel. Right for the
     * key light, which is always near white; useless on a dark one, where two channels a handful
     * of levels apart already read as a large ratio. */
    const cast = (hex: number): number => {
      const c = chanOf(hex);
      return Math.max(...c) / Math.max(1, Math.min(...c));
    };
    /** a colour's ABSOLUTE chroma, 0..1 — the right measure for the hemisphere's dark ground
     * bounce, where the ratio above is meaningless (`night`'s `0x1a1f2a` is 16 levels of spread
     * and a ratio of 1.62; `gym`'s deliberately warm `0x6b5c45` is 38 levels and only 1.55). */
    const chroma = (hex: number): number => {
      const c = chanOf(hex);
      return (Math.max(...c) - Math.min(...c)) / 255;
    };
    for (const e of BB_ENVIRONMENTS) {
      const r = e.rig;
      const [sx, sy, sz] = r.sun;
      const elevation = (Math.atan2(sz, Math.hypot(sx, sy)) * 180) / Math.PI;
      check(`${e.id}: the key light clears 25° of elevation`, elevation >= 25, `${elevation.toFixed(1)}°`);
      check(
        // 1.7 is `sunset`'s own amber (`0xffd2a0`, 1.59) plus a little, and it is a bound with a
        // MEASUREMENT behind it: at that key the rendered POLLEN-to-red-NECTAR contrast is 1.65,
        // against 1.68 under the neutral room — i.e. the warm key does not collapse the pair. A
        // real orange (`0xff8030`) is 5.3 and would.
        `${e.id}: the key light's own colour is a cast, not a filter`,
        cast(r.sunColor) <= 1.7,
        `${r.sunColor.toString(16)} ratio ${cast(r.sunColor).toFixed(2)}`,
      );
      check(
        // the widest in the list is `gym`'s wood bounce at 0.149 — a saturated floor bounce is
        // what turns a red NECTAR on a red hive tray into one shape, and this is the bound that
        // keeps every ground term inside "tinted" rather than "coloured".
        `${e.id}: the hemisphere GROUND bounce stays near neutral`,
        chroma(r.hemiGround) <= 0.16,
        `${r.hemiGround.toString(16)} chroma ${chroma(r.hemiGround).toFixed(3)}`,
      );
      check(
        `${e.id}: exposure and both hemisphere intensities are in range, and the no-IBL term is the larger`,
        r.exposure >= 1 && r.exposure <= 1.6 && r.hemiIbl > 0 && r.hemiIbl <= 4 && r.hemiNoIbl > r.hemiIbl,
        `exp ${r.exposure}, hemi ${r.hemiIbl}/${r.hemiNoIbl}`,
      );
    }

    // THE PAINTED DOMES. `look` is the recipe `scene/renderEnvironment.ts` paints; the room has
    // none (three's own `RoomEnvironment` plus the THEMED letterbox) and neither does a fetched
    // HDRI (the photograph is the surround).
    const painted = BB_ENVIRONMENTS.filter((e) => e.look);
    check('eight painted domes were added', painted.length === 8, String(painted.length));
    check('no environment is both painted and fetched', BB_ENVIRONMENTS.every((e) => !(e.look && e.hdri)));
    check(
      'the room is neither: it is three’s RoomEnvironment on the themed backdrop',
      !environmentDef('room').look && !environmentDef('room').hdri,
    );
    for (const e of painted) {
      const look = e.look!;
      const ts = look.sky.map(([t]) => t);
      check(
        `${e.id}: the dome's stops run zenith to nadir inside [0,1], no repeats`,
        look.sky.length >= 2 &&
          ts.every((t, i) => t >= 0 && t <= 1 && (i === 0 || t > ts[i - 1])) &&
          look.sky.every(([, c]) => c >= 0 && c <= 0xffffff),
        ts.join(','),
      );
      check(
        `${e.id}: the background's blur and dim are in range`,
        look.blur >= 0 && look.blur <= 1 && look.intensity > 0.5 && look.intensity <= 1,
        `blur ${look.blur}, intensity ${look.intensity}`,
      );
      if (look.lamp) {
        check(
          `${e.id}: the lamp sits somewhere on the dome`,
          look.lamp.az >= 0 &&
            look.lamp.az < 360 &&
            look.lamp.el > -90 &&
            look.lamp.el < 90 &&
            look.lamp.r > 0 &&
            look.lamp.r <= 60,
          JSON.stringify(look.lamp),
        );
      }
      if (look.truss) {
        check(
          `${e.id}: the truss ring is a bar above the horizon`,
          look.truss.el > 0 && look.truss.el < 90 && look.truss.h > 0 && look.truss.h < 20,
          JSON.stringify(look.truss),
        );
      }
      if (look.silhouette) {
        const sil = look.silhouette;
        check(
          `${e.id}: the silhouette band is BELOW the horizon and has teeth`,
          sil.top >= 0.5 && sil.bottom > sil.top && sil.bottom <= 1 && sil.teeth >= 4 && sil.alpha > 0 && sil.alpha <= 1,
          JSON.stringify(sil),
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────
    // THE VENUE (owner, 2026-09-21: "The graphic lighting environment is too basic. Make it
    // render an actual environment instead of blurry lights").
    //
    // A `scene.background` dome has no parallax, no horizon and — on the CAD field path — no
    // ground under it at all, so every environment now also builds REAL geometry around the
    // field (`scene/renderVenue.ts`). Every check below is a rule that geometry had to be
    // tuned INTO, and three of them are bugs the first build shipped and the captures caught.
    //
    // ⚠️ **THE VENUE IS BUILT FOR REAL HERE, BEHIND A ONE-METHOD CANVAS STUB.** It is DOM-free
    // except for the ground's `CanvasTexture`, and that one call is what this stub answers —
    // `THREE.CanvasTexture` only ever stores the object as `image`, so nothing downstream of it
    // needs a real 2D context. Measuring the built group is the whole point: "the shell is wider
    // than the orbit camera can zoom" is not a claim a grep can make.
    {
      const hadDoc = 'document' in globalThis;
      const stubCtx = new Proxy({}, { get: () => () => ({ addColorStop(): void {} }) });
      if (!hadDoc) {
        (globalThis as { document?: unknown }).document = {
          createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
        };
      }
      try {
        const ORBIT_RADIUS_MAX = 620; // `scene/renderCameras.ts` — the escape the guard exists for

        check('every environment carries a venue of a known kind', BB_ENVIRONMENTS.every((e) =>
          ['hall', 'arena', 'studio', 'outdoor'].includes(e.venue.kind)));
        check(
          'the eleven venues are not all one kind — a picker of identical rooms is one room',
          new Set(BB_ENVIRONMENTS.map((e) => e.venue.kind)).size === 4,
        );

        const chanOfV = (hexv: number): number[] => [(hexv >> 16) & 255, (hexv >> 8) & 255, hexv & 255];
        const chromaV = (hexv: number): number => {
          const c = chanOfV(hexv);
          return (Math.max(...c) - Math.min(...c)) / 255;
        };

        for (const e of BB_ENVIRONMENTS) {
          const v: VenueSpec = e.venue;
          // ⚠️ THE CAMERA-ESCAPE BOUND. `workshop` first shipped at 290 in — smaller than the
          // orbit ring's own zoom-out — so the eye stood outside a `BackSide` shell and the
          // walls simply vanished. The DATA is held to it as well as the builder's clamp, so a
          // new environment cannot reintroduce it and quietly rely on the guard.
          if (v.kind !== 'outdoor') {
            check(`${e.id}: the enclosure is wider than the orbit camera can zoom`, v.half > ORBIT_RADIUS_MAX, `half ${v.half}`);
            check(`${e.id}: the ceiling is above the field's tallest furniture and below the room's width`,
              v.ceil >= 160 && v.ceil < v.half, `ceil ${v.ceil}`);
          } else {
            check(`${e.id}: an outdoor horizon is far, and its ground stays inside the 4000-in far plane`,
              v.half >= 800 && v.half * 1.35 < 4000, `half ${v.half}`);
          }
          // GAMEPLAY BEATS MOOD, the same rule the rigs are held to: the alliance reds/blues, the
          // yellow POLLEN and the blue NECTAR are the only saturated things allowed in frame, so
          // no venue surface may be a colour — only a tint.
          for (const [what, hexv] of [['floor', v.floor], ['wall', v.wall], ['trim', v.trim]] as const) {
            check(`${e.id}: the venue ${what} is a tint, not a colour`, chromaV(hexv) <= 0.26, `${hexv.toString(16)} chroma ${chromaV(hexv).toFixed(3)}`);
          }
          check(`${e.id}: an unlit venue declares no fittings, and a lit one is not blinding`,
            v.lampPower >= 0 && v.lampPower <= 3 && (v.lampPower === 0 || v.lamp > 0), `${v.lampPower}`);
        }

        // ── the BUILT group ────────────────────────────────────────────────────────────────
        for (const e of BB_ENVIRONMENTS) {
          const g = buildBiobuzzVenue(e.venue, 'high');
          check(`${e.id}: the venue builds as one named group with a ground in it`,
            g.name === 'bb-venue' && !!g.getObjectByName('bb-venue:ground'));

          const ground = g.getObjectByName('bb-venue:ground') as THREE.Mesh;
          // BELOW the CAD's own ALLIANCE AREA tape (z −0.589…−0.579), which a ground at −0.5
          // covers — the same number and the same reason the deleted `bb-room` floor carried.
          check(`${e.id}: the ground is under the CAD's alliance-area tape`, Math.abs(ground.position.z + 0.75) < 1e-9, String(ground.position.z));
          check(`${e.id}: the ground receives shadow`, ground.receiveShadow === true);
          // ⚠️ WHITE TINT, NOT THE FLOOR COLOUR. `color` MULTIPLIES `map`, and the first build
          // passed the floor colour to both: a 0x555b63 practice-room floor rendered as its own
          // albedo SQUARED, i.e. near black, which is exactly what the first capture showed.
          check(`${e.id}: the ground's tint is white, so its texture is not squared`,
            (ground.material as THREE.MeshStandardMaterial).color.getHex() === 0xffffff);

          let casters = 0;
          let meshes = 0;
          g.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            meshes++;
            if (m.castShadow) casters++;
          });
          // ⚠️ NOTHING IN A VENUE CASTS. The sun's shadow camera is sized to the FIELD
          // (±90.674, far 260) so its texels are spent where a robot is; a venue caster is
          // outside that frustum by construction and would cost a depth-pass submission for a
          // shadow that cannot land anywhere.
          check(`${e.id}: no venue mesh casts a shadow`, casters === 0, `${casters} of ${meshes}`);
          // DRAWS are the budget a venue can spend badly, which is why every structural part is
          // an `InstancedMesh` over one unit box. MEASURED at `high`: 2 (outdoor) … 7 (arena,
          // the only ones carrying seating and a crowd), 470 … 5,762 triangles — against a
          // High scene total of 337k–462k (`docs/area/biobuzz.md`'s element measurement).
          check(`${e.id}: the whole venue is a handful of draws, not a scene`, meshes <= 9, String(meshes));
          let tris = 0;
          g.traverse((o) => {
            const m = o as THREE.Mesh & THREE.InstancedMesh;
            if (!m.isMesh) return;
            const geo = m.geometry;
            const n = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
            tris += n * (m.isInstancedMesh ? m.count : 1);
          });
          check(`${e.id}: and its triangle budget stays inside 2 % of a High scene`, tris <= 8000, String(Math.round(tris)));

          // ⚠️ NOTHING THIS MODULE BUILDS MAY STAND ON THE MAT, and the test has to be
          // PER-INSTANCE. The first spelling took `Box3.setFromObject` of each `InstancedMesh`
          // and failed on every one of them, correctly and uselessly: a colonnade RING's AABB
          // encloses the field by definition while no column is anywhere near it. So: walk the
          // instances, and a member passes if its own footprint clears the field rect OR it
          // hangs clear above it (a lighting truss and a ceiling fitting are over the field on
          // purpose; 130 in is well above the flowers, the hives and any shot arc that matters).
          const FIELD_RECT = 71;
          const OVERHEAD_CLEAR = 130;
          const im4 = new THREE.Matrix4();
          const pos3 = new THREE.Vector3();
          const scl3 = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          for (const child of g.children) {
            const im = child as THREE.InstancedMesh;
            if (!im.isInstancedMesh) continue;
            let intruders = 0;
            let worst = '';
            for (let i = 0; i < im.count; i++) {
              im.getMatrixAt(i, im4);
              im4.decompose(pos3, quat, scl3);
              const clearsRect =
                Math.abs(pos3.x) - scl3.x / 2 > FIELD_RECT || Math.abs(pos3.y) - scl3.y / 2 > FIELD_RECT;
              if (clearsRect || pos3.z - scl3.z / 2 >= OVERHEAD_CLEAR) continue;
              intruders++;
              worst = `(${pos3.x.toFixed(0)}, ${pos3.y.toFixed(0)}, ${pos3.z.toFixed(0)})`;
            }
            check(`${e.id}: every ${child.name} member clears the field or hangs over it`, intruders === 0, `${intruders} at ${worst}`);
          }

          if (e.venue.kind !== 'outdoor') {
            const shell = g.getObjectByName('bb-venue:shell') ?? g.getObjectByName('bb-venue:cyc');
            const box = new THREE.Box3().setFromObject(shell!);
            check(`${e.id}: the built enclosure clears the orbit camera's furthest zoom`,
              Math.min(box.max.x, box.max.y, -box.min.x, -box.min.y) > ORBIT_RADIUS_MAX,
              `${box.max.x.toFixed(0)} / ${box.max.y.toFixed(0)}`);
          }

          // DETERMINISM: the crowd, the horizon and the ground's mottle all come off a hash, so
          // two builds are the same venue — an exported replay's first frame cannot differ from
          // its second, or from anybody else's.
          const again = buildBiobuzzVenue(e.venue, 'high');
          const key = (root3: THREE.Object3D): string => {
            const parts: string[] = [];
            root3.traverse((o) => {
              const im = o as THREE.InstancedMesh;
              if (im.isInstancedMesh) parts.push(`${im.name}:${im.count}:${Array.from(im.instanceMatrix.array).join(',')}`);
            });
            return parts.join('|');
          };
          check(`${e.id}: two builds of the same venue are identical`, key(g) === key(again));
        }

        // ⚠️ THE CAMERA GUARD IS THE BUILDER'S, NOT THE DATA'S — a spec under the bound is
        // clamped rather than trusted, which is what makes the rule survive a new environment.
        {
          const tiny: VenueSpec = { kind: 'hall', floor: 0x555555, wall: 0x666666, trim: 0x777777, lamp: 0xffffff, lampPower: 1, half: 290, ceil: 172 };
          const box = new THREE.Box3().setFromObject(buildBiobuzzVenue(tiny, 'high').getObjectByName('bb-venue:shell')!);
          check('a venue authored too small is CLAMPED past the orbit zoom, not built as written',
            box.max.x > ORBIT_RADIUS_MAX, box.max.x.toFixed(0));
        }

        // THE LADDER. Low pays for a ground, a shell and its fittings and nothing else; the
        // trussing, the colonnade, the seating and the crowd are the three higher columns'.
        {
          const arena = environmentDef('arena').venue;
          const countOf = (d: 'low' | 'high'): number => {
            let n = 0;
            buildBiobuzzVenue(arena, d).traverse((o) => {
              if ((o as THREE.Mesh).isMesh) n++;
            });
            return n;
          };
          check('the low venue is strictly cheaper than the high one', countOf('low') < countOf('high'), `${countOf('low')} vs ${countOf('high')}`);
          check('low still has a ground and an enclosure — it is a cheaper room, not no room',
            !!buildBiobuzzVenue(arena, 'low').getObjectByName('bb-venue:ground') &&
              !!buildBiobuzzVenue(arena, 'low').getObjectByName('bb-venue:shell'));
        }

        // WHICH TIER GETS WHICH, and why it is not `bbWheelDetail`'s split: MEDIUM is where the
        // empty backdrop looked worst (image-based lighting is off there, so the dome was not
        // even lighting anything), and nine instanced boxes is not the budget a wheel's
        // sixteen lathed corners are.
        check('only Low takes the cut; Medium and up get the full venue',
          bbVenueDetail(GFX_PRESETS.low, 'low') === 'low' &&
            bbVenueDetail(GFX_PRESETS.medium, 'medium') === 'high' &&
            bbVenueDetail(GFX_PRESETS.high, 'high') === 'high' &&
            bbVenueDetail(GFX_PRESETS.ultra, 'ultra') === 'high');
        check('meshDetail: low keeps its promise here too',
          bbVenueDetail({ meshDetail: 'low' }, 'ultra') === 'low');

        // AND THE OLD SURROUND IS GONE. `bb-room` was a grey disc and a grey cylinder built by
        // the CONSTANTS fallback alone — a second floor at the venue's own z would z-fight
        // across the whole frame, and its 424-in cylinder would sit inside every hall's walls.
        {
          const fieldSrc = readFileSync(join(SCENE_DIR, 'renderField.ts'), 'utf8');
          check('the procedural bb-room is gone from the constants field', !/name = 'bb-room'/.test(fieldSrc));
        }
      } finally {
        if (!hadDoc) delete (globalThis as { document?: unknown }).document;
      }
    }

    // ⚠️ THE EXPORT'S ENVIRONMENT IS A CONTRACT, NOT A DEFAULT. §4.7 fixes a replay export at
    // HIGH so the file does not come out at whatever the machine that made it was set to, which
    // means `GFX_PRESETS.high.environment` is what every exported video is rendered in. Eight new
    // choices must not quietly become one of them.
    check('the fixed-High export tier still renders in the school hall', GFX_PRESETS.high.environment === 'school-hall');
    check('...and Ultra with it', GFX_PRESETS.ultra.environment === 'school-hall');
    check(
      'Low and Medium still default to the generated room',
      GFX_PRESETS.low.environment === 'room' && GFX_PRESETS.medium.environment === 'room',
    );
    check(
      'every preset column names a real environment',
      (['low', 'medium', 'high', 'ultra'] as const).every((t) =>
        (ENVIRONMENT_IDS as readonly string[]).includes(GFX_PRESETS[t].environment),
      ),
    );

    // AND NO GPU-ONLY DEPENDENCY CREPT INTO `graphics/`. It is read by `src/ui/GraphicsSection.tsx`
    // and `src/contributors.ts`, both ordinary main-bundle files: an import of `three` or of
    // anything under `scene/` from here would drag the renderer chunk into the main bundle.
    const graphicsDir = join(BIOBUZZ_DIR, 'graphics');
    for (const f of readdirSync(graphicsDir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(graphicsDir, f), 'utf8');
      check(
        `graphics/${f} imports neither three nor scene/`,
        !/from\s+['"]three/.test(src) && !/from\s+['"][^'"]*scene\//.test(src),
      );
    }

    // THE Z-UP FIX. An environment map is sampled in three's own y-up frame and this scene is
    // z-up, so an unrotated dome lies on its side — measured, the first sunset build painted the
    // sky underfoot. Both the background and the light-gathering map take the SAME rotation.
    {
      const envSrc = readFileSync(join(SCENE_DIR, 'renderEnvironment.ts'), 'utf8');
      check(
        'the environment map is rotated into the scene’s z-up frame, background AND lighting',
        /backgroundRotation\.copy\(MAP_ROT\)/.test(envSrc) && /environmentRotation\.copy\(MAP_ROT\)/.test(envSrc),
      );
      check(
        'a painted dome is the surround even with image-based lighting OFF (Low and Medium have a picker at all)',
        /applySky\(def, lighting\)/.test(envSrc) && /scene\.environment = lighting \? tex : null/.test(envSrc),
      );
      check('an HDRI with the lighting off is still NOT fetched', /if \(!lighting\) \{[\s\S]{0,120}applyRoom\(false\);/.test(envSrc));
      // a CALL, not the words: the file's own header explains why the star field is hashed
      // rather than random, and the check must not fail on its own reasoning
      check('the dome is painted with no Math.random() call (an export must repaint the same sky)', !/Math\.random\(/.test(envSrc));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // THE HDRI THAT CAN NEVER ARRIVE — the Discord Activity's CSP (audit #12).
  //
  // The activity is served through a proxy that admits only dsim's two Activity URL Mappings, so
  // `dl.polyhaven.org` is refused before the request leaves. `school-hall` is High's AND Ultra's
  // `environment` column and an ordinary desktop lands on one of those, so in the embed this was
  // the DEFAULT path: a blocked request per scene build, a silent substitution of three's generic
  // `RoomEnvironment` under a school hall's venue geometry, and a picker still advertising two
  // downloads that could not happen. `canFetchHdri` / `environmentDefFor` answer it up front.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  {
    /** run `fn` with `window` stubbed onto a host that IS (or is not) Discord's activity proxy.
     * Node has no `window` at all, which is why `inDiscordActivity()` reads false in this suite
     * by default — the embed branch is unreachable without this. */
    const onHost = <T>(hostname: string, fn: () => T): T => {
      const g = globalThis as { window?: unknown };
      const had = Object.prototype.hasOwnProperty.call(g, 'window');
      const prev = g.window;
      g.window = {
        location: { hostname, search: '' },
        sessionStorage: { getItem: () => null, setItem: () => undefined },
      };
      try {
        return fn();
      } finally {
        if (had) g.window = prev;
        else delete g.window;
      }
    };

    const fetched = BB_ENVIRONMENTS.filter((e) => e.hdri);

    // EVERY FETCHED ENTRY NAMES A STAND-IN, AND THE STAND-IN COSTS NOTHING. A fallback that is
    // itself an HDRI, or an id that does not exist, is a fallback with somewhere else to fall.
    check(
      'every fetched environment names a PAINTED stand-in',
      fetched.length > 0 &&
        fetched.every((e) => {
          const alt = BB_ENVIRONMENTS.find((x) => x.id === e.hdri!.fallback);
          return !!alt && !!alt.look && !alt.hdri;
        }),
      fetched.map((e) => `${e.id}→${e.hdri!.fallback}`).join(' '),
    );
    // AND IT STANDS IN THE SAME KIND OF ROOM. `renderScene` builds the VENUE off the same row it
    // lights from, so a hall that fell back to an outdoor horizon would put a sky where the
    // ceiling was — the substitution has to be a different picture of the same place.
    check(
      'a stand-in venue is the same KIND as the room it stands in for',
      fetched.every((e) => environmentDef(e.hdri!.fallback).venue.kind === e.venue.kind),
      fetched.map((e) => `${e.venue.kind}→${environmentDef(e.hdri!.fallback).venue.kind}`).join(' '),
    );

    // OFF-EMBED NOTHING MOVES. The photographs are still the High/Ultra default on the web and in
    // the desktop build, and the fixed-High replay export still renders in the school hall.
    check('outside an activity every id resolves to its own declared row', BB_ENVIRONMENT_IDS.every((id) => environmentDefFor(id) === environmentDef(id)));
    check('outside an activity an HDRI is still fetchable', canFetchHdri());
    check('...and the picker still offers all eleven', pickableEnvironments().length === BB_ENVIRONMENTS.length);
    check(
      'a plain website host is not an activity',
      onHost('playdsim.com', () => canFetchHdri() && environmentDefFor('school-hall').id === 'school-hall'),
    );

    // IN THE EMBED THE SUBSTITUTION IS TOTAL: nothing resolves to a row that needs a download.
    check('inside the activity an HDRI is known to be unfetchable up front', !onHost('1234.discordsays.com', () => canFetchHdri()));
    check(
      'inside the activity the school hall resolves to the painted school gym',
      onHost('1234.discordsays.com', () => environmentDefFor('school-hall').id) === 'gym',
      onHost('1234.discordsays.com', () => environmentDefFor('school-hall').id),
    );
    check(
      'inside the activity the photo studio resolves to the painted dark studio',
      onHost('1234.discordsays.com', () => environmentDefFor('monochrome-studio').id) === 'cyc-dark',
      onHost('1234.discordsays.com', () => environmentDefFor('monochrome-studio').id),
    );
    check(
      'inside the activity NO id resolves to a row that has to be downloaded',
      onHost('1234.discordsays.com', () => BB_ENVIRONMENT_IDS.every((id) => !environmentDefFor(id).hdri)),
    );
    // and only the two move: a substitution that also re-pointed the painted entries would be
    // changing the picture for a reason that has nothing to do with the CSP
    check(
      'inside the activity every PAINTED id is left exactly where it was',
      onHost('1234.discordsays.com', () =>
        BB_ENVIRONMENTS.filter((e) => !e.hdri).every((e) => environmentDefFor(e.id) === e),
      ),
    );
    check(
      'inside the activity the picker drops the two downloads and keeps the rest',
      onHost('1234.discordsays.com', () => {
        const list = pickableEnvironments();
        return list.length === BB_ENVIRONMENTS.length - fetched.length && list.every((e) => !e.hdri);
      }),
    );
    // NOTHING IS BUNDLED AND NOTHING IS REWRITTEN. The substitution is a read-time resolution:
    // the stored setting still says `school-hall`, so the same profile opened outside the embed
    // gets the photograph back, and no `.hdr` joined the repo to make this work.
    {
      const envDataSrc = readFileSync(join(BIOBUZZ_DIR, 'graphics', 'environments.ts'), 'utf8').replace(/\r\n/g, '\n');
      check('the fix stores nothing — no write of the resolved id anywhere in the data module', !/localStorage|setGraphicsSetting/.test(envDataSrc));
      check(
        'the two HDRIs are still fetched from Poly Haven, not from a bundled copy',
        fetched.every((e) => /^https:\/\/dl\.polyhaven\.org\//.test(e.hdri!.url)),
      );
      // ⚠️ THE ONE PREDICATE. `discordGroup()` answers "which party", which can legitimately be
      // unknown inside a live embed (a reload with third-party storage blocked); "which CSP is
      // over this document" is `inDiscordActivity()` and only that.
      check(
        'the CSP question is asked of inDiscordActivity(), never of the party',
        /export function canFetchHdri\(\): boolean \{\n\s*return !inDiscordActivity\(\);\n\}/.test(envDataSrc),
      );
    }

    // THE RENDERER READS THE RESOLVED ROW FOR ALL THREE OF ITS JOBS. The rig, the venue and the
    // surround come off one row; before this they disagreed in the embed, which is how a school
    // hall's walls ended up around a field lit by three's generic box.
    {
      const sceneSrc = readFileSync(join(SCENE_DIR, 'renderScene.ts'), 'utf8');
      check('applyQuality lights and builds the venue from the RESOLVED row', /const def = environmentDefFor\(s\.environment\)/.test(sceneSrc));
      check('...and nothing in the scene reads the raw declared row any more', !/\benvironmentDef\(/.test(sceneSrc));
      const envSrc = readFileSync(join(SCENE_DIR, 'renderEnvironment.ts'), 'utf8');
      check('the loader resolves the same way before it considers fetching', /const def = environmentDefFor\(id\)/.test(envSrc));
      // A FAILURE IS REMEMBERED. Only successes were cached, so a refused fetch was re-issued on
      // every scene build and every graphics-settings change.
      check(
        'a failed .hdr is remembered for the document, not re-requested per scene',
        /failedHdri\.set\(id, \(failedHdri\.get\(id\) \?\? 0\) \+ 1\)/.test(envSrc) &&
          /if \(\(failedHdri\.get\(id\) \?\? 0\) >= HDRI_MAX_TRIES\) \{/.test(envSrc),
      );
      check(
        'graphics: the environment picker offers only what this client can fetch',
        /options=\{pickableEnvironments\(\)\.map\(/.test(readFileSync('src/ui/GraphicsSection.tsx', 'utf8')) &&
          !/options=\{BB_ENVIRONMENTS\.map\(/.test(readFileSync('src/ui/GraphicsSection.tsx', 'utf8')),
        'in the embed the HDRI host is not a URL mapping, so those tiles advertised a download that cannot happen',
      );
      check('...in MODULE scope, so it outlives the scene that learned it', /^const failedHdri = new Map<EnvironmentId, number>\(\);$/m.test(envSrc));
      check(
        '⚠️ ...but it COUNTS, so one blip does not cost the real environment for the whole run',
        /^const HDRI_MAX_TRIES = 2;$/m.test(envSrc),
        'a document is a whole Electron run; blacklisting on the first miss meant one bad second lasted until a restart',
      );
      check(
        '⚠️ ...and only the FETCH counts, so a GPU failure never blacklists a download that worked',
        // exactly ONE place records a failure, and it is the catch wrapped around the FETCH.
        // (A "no set() near a catch(err)" test cannot work: the legitimate fetch-catch is
        // itself a `catch (err)` with the set inside it — which is how this check first went
        // red. Counting the sites and pinning the one is the discriminator that holds.)
        (envSrc.match(/failedHdri\.set\(/g) ?? []).length === 1 &&
          /loadAsync\(def\.hdri\.url\);\s*\} catch \(err\) \{\s*failedHdri\.set\(/.test(envSrc),
      );
      check(
        '⚠️ ...and the count does not last the whole run: a success clears it, and it expires',
        /failedHdri\.set\([^\n]*\n\s*hdriFailedAt\.set\(id, Date\.now\(\)\);\s*throw err;\s*\}\s*failedHdri\.delete\(id\);/.test(envSrc) &&
          /if \(Date\.now\(\) - \(hdriFailedAt\.get\(id\) \?\? 0\) >= HDRI_RETRY_MS\) failedHdri\.delete\(id\);\s*if \(\(failedHdri\.get\(id\) \?\? 0\) >= HDRI_MAX_TRIES\) \{/.test(envSrc),
        'two blips in one Electron run used to mean the stand-in until a restart',
      );
      // and the failure lands on the entry's own stand-in rather than on the flattest row there is
      check('a failed fetch falls back to the entry’s stand-in, not to `room`', /const alt = applyFallback\(def, lighting\);/.test(envSrc));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // THE FLOWER CONTENTS READ-OUT OVER THE 3D TOP-DOWN SHOT (owner, 2026-09-21: "for the top down
  // view of the 3d render, add a separate thing (like the 2d display) that shows inside the
  // flower").
  //
  // It is the 2D renderer's OWN `drawBiobuzzFlowerSections`, under an affine transform recovered
  // from three projected floor points — so what is checked here is the three things that are this
  // file's own: WHEN it draws, WHAT transform it draws under, and that it is still the same
  // drawing with the same elements in the same order.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  {
    interface Disc {
      x: number;
      y: number;
      r: number;
      fill: string;
    }
    /** a permissive recording ctx: every call is a no-op, `arc` is kept with the fill in force,
     * and the TOP-LEVEL `setTransform` is kept because that is the projection under test. */
    const record = (draw: (ctx: CanvasRenderingContext2D) => void): { discs: Disc[]; xf: number[][] } => {
      const discs: Disc[] = [];
      const xf: number[][] = [];
      let fill = '';
      const sink: unknown = new Proxy(function () {}, { get: () => sink, apply: () => sink });
      const ctx = new Proxy(
        {},
        {
          get: (_t, k) => {
            if (k === 'fillStyle') return fill;
            if (k === 'arc') {
              return (x: number, y: number, r: number) => {
                discs.push({ x, y, r, fill: String(fill) });
              };
            }
            if (k === 'setTransform') {
              return (...a: number[]) => {
                xf.push(a);
              };
            }
            return sink;
          },
          set: (_t, k, v) => {
            if (k === 'fillStyle') fill = String(v);
            return true;
          },
        },
      ) as unknown as CanvasRenderingContext2D;
      draw(ctx);
      return { discs, xf };
    };

    /** THE OVERHEAD CAMERA'S OWN MAP, as a `project`: `Camera.worldToScreen`'s rotate-then-y-flip,
     * which is exactly what `renderCameras.ts`'s `updateOverhead` builds (an orthographic camera
     * straight above the origin whose `up` is the driver's screen-up). Orthographic + a plane is
     * affine, which is the property the read-out relies on and verifies for itself. */
    const PX_PER_IN = 4;
    const flatView = (viewAngle: number, camera: SceneOverlayView['camera'] = 'overhead'): SceneOverlayView => ({
      camera,
      viewAngle,
      dpr: 2,
      project: (x, y, _z, out) => {
        const c = Math.cos(viewAngle);
        const sn = Math.sin(viewAngle);
        out.x = 640 + (x * c - y * sn) * PX_PER_IN;
        out.y = 360 - (x * sn + y * c) * PX_PER_IN;
        out.visible = true;
      },
    });

    // A WORLD WITH SOMETHING TO SAY. The staged field is four columns of identical POLLEN, which
    // cannot show an ORDER — so one flower gets a NECTAR on top (who owns it) and another gets one
    // at the BOTTOM (the 5-point bonus, and the element that locks retrieval under G418).
    const fw = createBiobuzzWorld('free', 11, []);
    const fById = new Map(fw.balls.map((b) => [b.id, b]));
    const fStacks = fw.biobuzz!.flowers.map((f) => f.stack);
    check(
      'the staged world gives every flower a column to read',
      fStacks.every((s) => s.length >= 3),
      fStacks.map((s) => s.length).join(','),
    );
    const topOf1 = fById.get(fStacks[1][fStacks[1].length - 1])!;
    topOf1.color = 'red';
    topOf1.r = 1.8;
    const botOf2 = fById.get(fStacks[2][0])!;
    botOf2.color = 'blue';
    botOf2.r = 1.8;

    const POLLEN_INK = '#f2d14b';
    const NECTAR_BLUE_INK = '#007be1';
    const NECTAR_RED_INK = C.COLORS.red.toLowerCase();
    const EL_FILLS = [POLLEN_INK, NECTAR_RED_INK, NECTAR_BLUE_INK];
    const isElement = (d: Disc): boolean => d.r >= 1 && EL_FILLS.includes(d.fill.toLowerCase());

    // ── WHEN IT DRAWS ─────────────────────────────────────────────────────────────────────
    const overhead = record((ctx) => drawBiobuzzFlowerReadout(ctx, fw, flatView(0)));
    const drawn = overhead.discs.filter(isElement);
    const want = fStacks.reduce((n, s) => n + s.length, 0);
    check('overhead: one disc per element in all four columns', drawn.length === want, `${drawn.length} vs ${want}`);
    for (const cam of ['driver', 'chase', 'orbit', 'free'] as const) {
      check(
        `${cam}: nothing is drawn — the column is visible through the flower's own open sides`,
        record((ctx) => drawBiobuzzFlowerReadout(ctx, fw, flatView(0, cam))).discs.length === 0,
      );
    }
    // ⚠️ THE 2D SLOT STAYS EMPTY, and that is the check that stops the sections being painted
    // TWICE on the flat map — `drawBiobuzzField` already draws them there. The 3D slot is a
    // SEPARATE one for a reason `games/module.ts` records: a third argument on `drawOverlays`
    // silently handed DECODE's world-inch ramp strips a screen-pixel transform.
    check('BIOBUZZ fills the 3D slot and leaves the 2D one empty', !BIOBUZZ_MODULE.drawOverlays && !!BIOBUZZ_MODULE.drawSceneOverlay);
    check(
      'the module slot draws the read-out',
      record((ctx) => BIOBUZZ_MODULE.drawSceneOverlay!(ctx, fw, flatView(0))).discs.filter(isElement).length === drawn.length,
    );
    for (const id of ['decode', 'chain'] as const) {
      check(`${id} fills no 3D overlay slot, so a scene of its own would draw none of this`, !moduleFor(id).drawSceneOverlay);
    }

    // ── AND REFUSES A PROJECTION IT CANNOT DRAW THROUGH ───────────────────────────────────
    // The affine transform is legitimate for an ORTHOGRAPHIC top-down camera and for nothing
    // else. A camera that grew a perspective or a tilt must make this stop drawing, not draw the
    // four sections in the wrong places — so the recovered map is CHECKED against a fourth point.
    const bent: SceneOverlayView = {
      ...flatView(0),
      project: (x, y, _z, out) => {
        out.x = 640 + x * PX_PER_IN + x * y * 0.01;
        out.y = 360 - y * PX_PER_IN;
        out.visible = true;
      },
    };
    check('a projection that is not affine draws nothing at all', record((ctx) => drawBiobuzzFlowerReadout(ctx, fw, bent)).discs.length === 0);
    const degenerate: SceneOverlayView = {
      ...flatView(0),
      project: (_x, _y, _z, out) => {
        out.x = 640;
        out.y = 360;
        out.visible = true;
      },
    };
    check('a degenerate (edge-on) camera draws nothing', record((ctx) => drawBiobuzzFlowerReadout(ctx, fw, degenerate)).discs.length === 0);

    // ── THE TRANSFORM IT DRAWS UNDER, AND THAT IT TURNS WITH THE ALLIANCE ─────────────────
    check(
      'one top-level setTransform, carrying the device pixel ratio',
      overhead.xf.length === 1 && overhead.xf[0].length === 6,
      JSON.stringify(overhead.xf[0]),
    );
    {
      const [a, b, c2, d] = overhead.xf[0];
      const k = PX_PER_IN * 2; // dpr 2
      check(
        'at viewAngle 0 the map is the overhead camera’s own rotate-then-y-flip, times the dpr',
        Math.abs(a - k) < 1e-6 && Math.abs(b) < 1e-6 && Math.abs(c2) < 1e-6 && Math.abs(d + k) < 1e-6,
        overhead.xf[0].map((n) => n.toFixed(3)).join(','),
      );
    }
    for (const va of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const [a, b, c2, d] = record((ctx) => drawBiobuzzFlowerReadout(ctx, fw, flatView(va))).xf[0];
      const k = PX_PER_IN * 2;
      check(
        `the read-out turns with viewAngle ${((va * 180) / Math.PI).toFixed(0)}°, like the shot it is drawn over`,
        Math.abs(a - k * Math.cos(va)) < 1e-6 &&
          Math.abs(b + k * Math.sin(va)) < 1e-6 &&
          Math.abs(c2 + k * Math.sin(va)) < 1e-6 &&
          Math.abs(d + k * Math.cos(va)) < 1e-6,
        [a, b, c2, d].map((n) => n.toFixed(3)).join(','),
      );
    }

    // ── AND IT IS THE SAME DRAWING, IN THE SAME ORDER ────────────────────────────────────
    // The elements come out in `BB_FLOWERS` order and, inside a column, bottom to top — because
    // this is `drawBiobuzzFlowerSections`, driven by `flowerStackZ`, and not a second copy of the
    // stacking arithmetic. A fork would be free to disagree with the scorer; this cannot.
    {
      let k = 0;
      let ok = true;
      const detail: string[] = [];
      for (const s of fStacks) {
        for (const id of s) {
          const colour = fById.get(id)!.color;
          const got = drawn[k]?.fill.toLowerCase();
          const wantFill = colour === 'red' ? NECTAR_RED_INK : colour === 'blue' ? NECTAR_BLUE_INK : POLLEN_INK;
          if (got !== wantFill) {
            ok = false;
            detail.push(`#${k} want ${wantFill} got ${got}`);
          }
          k++;
        }
      }
      check('every column reads bottom-to-top in the elements’ own colours', ok, detail.slice(0, 4).join(' | '));
    }
    {
      // and the NECTAR are drawn at a NECTAR's radius: the size is the other half of what the
      // read-out says, and it comes off the element rather than off a constant in the renderer
      const radii = new Set(drawn.map((d) => d.r));
      check(
        'a NECTAR is drawn bigger than a POLLEN, at the elements’ real radii',
        radii.has(1.8) && radii.has(BB_POLLEN_R) && radii.size === 2,
        [...radii].join(','),
      );
    }

    // ── THE SEAM IT REACHES THE OVERLAY THROUGH ──────────────────────────────────────────
    {
      const rSrc = readFileSync(join(root, 'src', 'render', 'renderer.ts'), 'utf8');
      const readoutSrc = readFileSync(join(root, 'src', 'games', 'biobuzz', 'drawFlowerReadout.ts'), 'utf8');
      check(
        'the 3D overlay pass hands the game its own slot, with the camera the SCENE resolved',
        /mod\.drawSceneOverlay\(ctx, world, \{/.test(rSrc) && /scene\.camera \?\? 'driver'/.test(rSrc),
      );
      const sceneSrc2 = readFileSync(join(SCENE_DIR, 'renderScene.ts'), 'utf8');
      check(
        'BiobuzzScene reports the camera the last frame RESOLVED to, not the one the host asked for',
        /get camera\(\): SceneCamera \{[\s\S]{0,60}return this\.lastCamera;/.test(sceneSrc2),
      );
      const fieldSrc = readFileSync(join(root, 'src', 'games', 'biobuzz', 'drawField.ts'), 'utf8');
      check(
        'the read-out goes through the 2D renderer’s own section drawing',
        /export function drawBiobuzzFlowerSections/.test(fieldSrc) && /drawBiobuzzFlowerSections/.test(readoutSrc),
      );
      // ⚠️ AND IT DRAWS NOTHING OF ITS OWN. This is the check that keeps the two views from ever
      // parting company: the file works out ONE transform and hands over. The moment it grows an
      // `arc`, a `fillStyle` or a `lineWidth` it has started keeping a second opinion about what
      // a FLOWER looks like, and `drawFlowerSection`'s header explains why that drifts from the
      // SCORER rather than merely from the other picture.
      check(
        'and draws no primitive of its own — one transform, then the shared drawing',
        !/ctx\.(arc|fill|stroke|rect|moveTo|lineTo|beginPath)/.test(readoutSrc) &&
          !/ctx\.(fillStyle|strokeStyle|lineWidth|globalAlpha)\s*=/.test(readoutSrc) &&
          /ctx\.setTransform\(/.test(readoutSrc),
      );
      check('and the PiP minimap is left out deliberately, in writing', /PiP minimap/.test(readoutSrc));
    }
  }
}
