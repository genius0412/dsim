import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Alliance, RobotSpec, RobotState, World } from '../../../types';
import { chassisFill, COLORS, INTAKE_RAIL_T } from '../../../config';
import { accentFill, clampCosmetics } from '../../../cosmetics';
import { starPoints } from '../../../render/drawRobot';
import { robotsEnabled } from '../../../sim/match';
// TYPES ONLY, and the direction matters: `graphics/` may not import `scene/` or `three` (the
// RENDER lane asserts it), but the scene reading the settings MODEL is how every other quality
// dial already works — see `renderPreview.ts`, which imports the store itself.
import type { GraphicsSettings, GraphicsTier } from '../graphics/settings';
import {
  BB3_MOUTH_SLOT_Z,
  BB_BOX_TUBE_ARM_T,
  BB_BOX_TUBE_ARM_W,
  BB_BOX_TUBE_COLLAR,
  BB_BOX_TUBE_BASE_BELOW,
  BB_BOX_TUBE_CLAW_REACH,
  BB_BOX_TUBE_DRUM_R,
  BB_BOX_TUBE_DRUM_T,
  BB_BOX_TUBE_EXTEND_S,
  BB_BOX_TUBE_EXT_SLEW,
  BB_BOX_TUBE_JAW_H,
  BB_BOX_TUBE_JAW_L,
  BB_BOX_TUBE_JAW_ROOT,
  BB_BOX_TUBE_JAW_T,
  BB_BOX_TUBE_PALM_BACK,
  BB_BOX_TUBE_PLATE_GAP,
  BB_BOX_TUBE_PLATE_T,
  BB_BOX_TUBE_RETRACT_F,
  BB_BOX_TUBE_SECTIONS,
  BB_BOX_TUBE_SLEW,
  BB_BOX_TUBE_WALL,
  BB_BOX_TUBE_WRIST_E,
  BB_BOX_TUBE_WRIST_H,
  BB_BOX_TUBE_WRIST_HALF,
  BB_BOX_TUBE_WRIST_TOP,
  BB_BOX_TUBE_YOKE_OUT,
  BB_BOX_TUBE_Z,
  bbBoxTubeFrame,
  bbBoxTubeJoints,
  bbBoxTubePose,
  bbBoxTubeStages,
  bbBoxTubeStowedBoxes,
  type BbBoxTubeFrame,
  BB_DECK_Z,
  BB_FLOWERS,
  FLOWER_MOUTH,
  BB_DUMP_RELOAD_S,
  BB_DUMP_SEAT_PITCH,
  BB_FEED_WALL_T,
  BB_FLYWHEEL_R,
  bbHead,
  BB_HOOD_SIDE_CLEAR,
  BB_HOOD_T,
  BB_HOOD_WRAP,
  BB_INTAKE_DRAW_IN,
  BB_LAUNCH_Z0,
  BB_MOTOR_MOUNT_RIM,
  BB_RAMP_ANGLE,
  BB_RAMP_DEPLOY_S,
  BB_RAMP_DECK_Z,
  BB_RAMP_IN,
  BB_RAMP_L,
  BB_RAMP_OUT,
  BB_RAMP_PIVOT_BACK,
  BB_RAMP_PIVOT_Z,
  BB_RAMP_WEDGE_THICK,
  BB_SIDE_PLATE_BOTTOM_Z,
  BB_SIDE_PLATE_FRONT_X,
  BB_SIDE_PLATE_TOP_Z,
  BB_SIDE_ROLLER_BOSS_R,
  BB_SIDE_ROLLER_H,
  BB_SIDE_ROLLER_HUB_R,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_PLATE_T,
  BB_SIDE_ROLLER_R,
  BB_SIDE_ROLLER_YOKE_BACK,
  BB_SIDE_ROLLER_YOKE_W,
  bbSideRollerY,
  bbSideRollerYokeY,
  BB_SIDE_ROLLER_Z,
  BB_TURRET_AXLE_Z,
  BB_TURRET_BRACE_R,
  BB_TURRET_BRACES,
  BB_SHOOTER_PLATE_T,
  BB_TURRET_MOTOR_R,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_REST,
  BB_TURRET_PLATE_T,
  BB_TURRET_PLATE_TOP_Z,
  BB_TURRET_RING_H,
  bbHopperCap,
  type BbHeadDims,
} from '../config';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf, type BbLauncherSpec } from '../mechs';
import {
  BB_END_BAR_H,
  BB_FRONT_ARROW_T,
  BB_FRONT_INK,
  BB_REAR_INK,
  bbEndBarSegments,
  bbFrontMarks,
} from '../parts';
import { bbFlowerInReach, bbMouths, bbMuzzleLocal, bbPlacePointLocal } from '../robot';
import { bbSpecKey } from '../specKey';
import {
  bbMouthFrame,
  bbShooterEdgeOf,
  EDGE_ANGLE,
  edgeGeom,
  turretLocal,
  turretRadius,
  type BbMountPos,
} from '../mounts';

/**
 * BIOBUZZ 3D SCENE — generated robots (Day 1, `docs/biobuzz/plan-3d.md` §3.3, §4.2).
 *
 * One `THREE.Group` per robot id, built from the spec ONCE and rebuilt only when the spec
 * identity changes (`bbSpecKey`). Posed every frame at `(pos.x, pos.y, r.z ?? 0)` —
 * `RobotState.z` is the chassis BOTTOM height (plan §2.4/§3.3; absent reads 0, exactly right
 * for a 2D-physics world) — with yaw `heading`.
 *
 * HEADING CONVENTION: `RobotState.heading` is field-frame radians, 0 = +x, CCW positive
 * (`types.ts`), and the robot's own local frame is +x forward / +y left (`mounts.ts`'s header).
 * A `Group.rotation.z = heading` maps local +x to world `(cos, sin)`, which is exactly that
 * convention — no sign flip needed, unlike the DECODE bird's-eye mirroring gotcha in CLAUDE.md
 * (that one is a SCREEN-space schematic; this is a plain world-frame yaw).
 *
 * ── WHAT A ROBOT IS, AND WHAT IT IS NOT (owner playtest, 2026-09-18) ────────────────────────
 * It used to be a SOLID BOX `length × width × heightIn` with a stick on top, which drew three
 * complaints at once: "way too tall for no apparent reason", "the drivetrain should not be a
 * box", "the launcher looks horrible". All three are the same mistake — the collider was being
 * drawn instead of the robot. `heightIn` is a PHYSICS extent (R105.A's sizing volume, and what
 * `sim3d` builds its cuboid from); nothing on a real FTC robot is solid to that height.
 *
 * So the picture is built the way the machine is:
 *  · a LOW DRIVETRAIN — two parallel side plates per side with the wheels BETWEEN them, cross
 *    members front and rear, a belly pan and a partial deck, all inside `BB_PLATE_H`;
 *  · an OPEN TOWER — four thin uprights and a top rail carrying the declared height, so a tall
 *    build still reads as tall without reading as a brick;
 *  · the MECHANISMS standing on the deck: a hooded flywheel on its turntable (or a dumper's
 *    pivoted tray) and an over-the-bumper intake reaching the sim's own footprint.
 *
 * The footprint is still exactly `spec.length × spec.width` — the outer face of each side plate
 * IS the frame — and the intake still reaches exactly `bbMouths`, which is `footprintExtents`.
 */

/**
 * EVERY GEOMETRY AND MATERIAL THIS MODULE SHARES BETWEEN ROBOTS, registered as it is created.
 *
 * `disposeRobotGroup` (bottom of the file) is what reads them, and the reason it has to exist
 * at all: a group is thrown away and rebuilt whenever `bbSpecKey` changes, which in a match is
 * rare and in the BUILDER is every drag of a slider. A blanket `traverse` + `dispose()` over a
 * discarded group would free the frame geometry, the roller texture and every solid material
 * that the next group — and every other robot on the field — is still using, so three would
 * re-upload the buffers and recompile the programs on the next frame. Disposing NOTHING leaks
 * the per-robot meshes instead. These sets are how the walk tells the two apart.
 */
const SHARED_GEO = new Set<THREE.BufferGeometry>();
const SHARED_MAT = new Set<THREE.Material>();

const BODY_MAT_CACHE = new Map<string, THREE.MeshStandardMaterial>();
function solidMat(color: string, roughness = 0.6, metalness = 0.1): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = BODY_MAT_CACHE.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    BODY_MAT_CACHE.set(key, m);
    SHARED_MAT.add(m);
  }
  return m;
}

/**
 * THE FRONT LIGHT BAR'S MATERIAL — the ONE emissive on a robot, and the only reason it is not
 * `solidMat`. A matte white bar is the same grey as the deck under the hive's shadow, which is
 * where a driver most needs to know which end is the front; `emissive` at full strength makes it
 * a light rather than a painted stripe, and it needs no light of its own to do it. Cached and
 * SHARED like every other material here, so `disposeRobotGroup` leaves it alone.
 */
let FRONT_BAR_MAT: THREE.MeshStandardMaterial | null = null;
function frontBarMat(): THREE.MeshStandardMaterial {
  if (!FRONT_BAR_MAT) {
    FRONT_BAR_MAT = new THREE.MeshStandardMaterial({
      color: BB_FRONT_INK,
      emissive: BB_FRONT_INK,
      emissiveIntensity: 0.85,
      roughness: 0.35,
      metalness: 0,
    });
    SHARED_MAT.add(FRONT_BAR_MAT);
  }
  return FRONT_BAR_MAT;
}

/** every mesh this module builds casts a shadow; nothing here receives one back onto itself
 * (the field floor/hive/flowers do that — see `renderScene.ts`'s `applyShadowFlags`). One call
 * per part rather than a post-hoc traversal, so a group rebuilt mid-match (`specKey` changing)
 * never has to be re-walked to pick the flag back up. */
function cast<T extends THREE.Object3D>(o: T): T {
  o.castShadow = true;
  return o;
}

/** the shared alliance red, so a 3D robot matches the 2D view of the same match */
const RED = COLORS.red;
/** the one BIOBUZZ blue, not the shared `C.COLORS.blue` (`#3b82f6`, a DECODE/CR UI token at
 * OKLCH hue 259.8°). Owner bug 12, 2026-09-19 — `draw.ts`'s `ELEMENT_FILL` header has the
 * measurement and the reason the CAD's own rib colour was NOT taken. */
const BLUE = '#007be1';
/** the one rubber tone on the robot: a mecanum's roller barrels, an omni's, a traction tyre's
 *  band. (`WHEEL`, a second near-identical dark, is gone with the roller-stripe texture that was
 *  its only reader — see `BB_WHEEL_PARTS`.) */
const TREAD = '#262c35';
const ALU = '#98a3b2';
const ALU_DK = '#39414f';
const TURRET_RING = '#39414f';
const TURRET_BARREL = '#5c6676';
const SWEEPER = '#12161c';
const DUMPER_BUCKET = '#8a94a3';
const MOTOR = '#2b313a';

/**
 * COSMETICS — the 3D twin of `render/drawRobot.ts`'s `tintColor` (not imported: that module
 * pulls in `sim/field`/`sim/robot`, which have no business in this LAZY chunk — see the RENDER
 * lane's chunk-boundary rules above). Blends `accent` into a structural base colour so a
 * mechanism (a wheel, a roller hub) reads the cosmetic without losing its own material tone.
 * Every caller that adds an `accent` parameter below defaults it to that part's OWN base colour,
 * which makes `tint3d(base, base, amt) === base` — a true no-op, so every existing call site
 * that predates cosmetics (this file's own tests included) is unchanged.
 */
function hexToRgb3d(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function tint3d(base: string, accent: string, amt: number): string {
  const [br, bg, bb] = hexToRgb3d(base);
  const [ar, ag, ab] = hexToRgb3d(accent);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amt);
  return `#${[mix(br, ar), mix(bg, ag), mix(bb, ab)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVETRAIN DIMENSIONS — inches. GEOMETRY, not physics: nothing below is read by the sim, and
// none of it changes a collider. APPROX, sized off ordinary FTC hardware, and deliberately
// INDEPENDENT of `spec.heightIn`: a drivetrain does not get taller because the robot above it
// does, which is the whole of complaint #9.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * side-plate height — a real drivetrain is a 4-ish inch channel, and this is the number that
 * decides how much of a robot reads as "chassis".
 *
 * ⚠️ IT IS `BB_DECK_Z`, IMPORTED, NOT A LOCAL 4.6. The whole turret stack is measured up from the
 * deck (`BB_TURRET_RING_H`, `BB_TURRET_PLATE_TOP_Z`, `BB_TURRET_AXLE_Z`) and that stack is in
 * `config.ts` now, so the deck cannot be a second number typed here. The drivetrain's side plate
 * IS the deck's height by construction, which is the statement this line makes.
 */
const BB_PLATE_H = BB_DECK_Z;
/** plate thickness. The OUTER plate's outer face is the frame line, so the footprint of the
 * built group is exactly `spec.length × spec.width`. */
const BB_PLATE_T = 0.22;
/** ⚠️ THE WHEEL CHANNEL'S OWN DIMENSIONS (`BB_WHEEL_R`, `BB_WHEEL_W`, `BB_PLATE_GAP`) ARE NOT
 *  DECLARED HERE ANY MORE. They are the goBILDA 104 mm mecanum's radius and width, so they are
 *  declared with the part they come from — see `BB_WHEEL_PARTS` below. They used to be a typed
 *  "4-in wheel, the FTC default", which was neither the wheel the owner asked for nor the 104 mm
 *  `C.WHEEL_DIAMETER_MM` the sim's own top speed is derived from. */
/** square section of the cross members, the belly pan and the tower uprights. */
const BB_RAIL_T = 0.95;

/** the drivetrain's inner clear width (between the two inner plates) for a given chassis. */
function innerHalfWidth(spec: Pick<RobotSpec, 'width'>): number {
  return Math.max(0.6, spec.width / 2 - BB_PLATE_T * 2 - BB_PLATE_GAP);
}

/**
 * ⚠️ NOTHING HERE DRAWS `heightIn`, AND THAT IS THE POINT (owner, 2026-09-18).
 *
 * The first pass at complaint #9 carried the declared height as an open two-post mast on a free
 * chassis edge. It answered the wrong question: a bare goalpost standing on the deck IS "tall for
 * no apparent reason", just in a thinner shape. A ROBOT'S VISUAL HEIGHT IS WHATEVER ITS
 * MECHANISMS REACH. `heightIn` is a collider extent (R105.A's sizing volume, and what `sim3d`
 * builds its cuboid from); the match view does not indicate it at all, and the one place it is
 * shown is the BUILDER turntable, as a dashed measurement outline that is visibly not hardware
 * (`renderPreview.ts`). Do not reintroduce a height indicator here.
 */

/**
 * A FLAT PLATE WITH LIGHTENING HOLES, in the chassis's x–z plane (thickness along y).
 *
 * `ExtrudeGeometry` with `Path` holes is core three.js, so a plate that looks milled costs one
 * extrusion and no dependency. Built in shape space `(u = along, v = up)` and rotated once:
 * `rotateX(+π/2)` maps shape `v → world z` and the extrusion depth `→ world −y`, which is the
 * orientation every caller wants (a side plate standing up along the chassis).
 */
function platePlane(along: number, up: number, t: number, holes: number): THREE.ExtrudeGeometry {
  const hu = along / 2;
  const hv = up / 2;
  const r = Math.min(0.6, up * 0.18);
  const shape = new THREE.Shape();
  shape.moveTo(-hu + r, -hv);
  shape.lineTo(hu - r, -hv);
  shape.quadraticCurveTo(hu, -hv, hu, -hv + r);
  shape.lineTo(hu, hv - r);
  shape.quadraticCurveTo(hu, hv, hu - r, hv);
  shape.lineTo(-hu + r, hv);
  shape.quadraticCurveTo(-hu, hv, -hu, hv - r);
  shape.lineTo(-hu, -hv + r);
  shape.quadraticCurveTo(-hu, -hv, -hu + r, -hv);
  const holeR = Math.min(up * 0.26, along / (holes * 2.6));
  if (holes > 0 && holeR > 0.25) {
    for (let i = 0; i < holes; i++) {
      const u = -hu + ((i + 0.5) * along) / holes;
      const path = new THREE.Path();
      path.absarc(u, 0, holeR, 0, Math.PI * 2, true);
      shape.holes.push(path);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 8 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, t / 2, 0); // extrusion runs into −y; centre it on the plate's own plane
  return geo;
}

/** a box, pre-placed — the merge below wants world-space geometry, not meshes. */
function boxAt(sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/**
 * ONE MERGED, CACHED MESH per (key, material) — the draw-call budget, and the reason the new
 * drivetrain does not cost four times what the box did.
 *
 * A robot's frame is ~16 separate boxes and plates, all static relative to the chassis and all
 * one material. Merged they are ONE draw call (two with the shadow pass) instead of sixteen, and
 * because the merge is keyed on the dimensions that produced it, four robots on the same build
 * share the buffer. The source geometries are temporaries and are disposed the moment the merge
 * has copied them; only the merged result is registered as SHARED.
 */
const FRAME_CACHE = new Map<string, THREE.BufferGeometry>();
function framePart(key: string, build: () => THREE.BufferGeometry[]): THREE.BufferGeometry {
  const hit = FRAME_CACHE.get(key);
  if (hit) return hit;
  const built = build();
  // ⚠️ **EVERY PART IS FLATTENED TO NON-INDEXED FIRST, AND THAT IS NOT TIDINESS.**
  // `mergeGeometries` refuses a list that mixes indexed and non-indexed buffers — it logs and
  // returns `null`, and the fallback below then hands back `parts[0]`, so the merge SILENTLY
  // DROPS EVERY PART AFTER THE FIRST. A `BoxGeometry` is indexed and an `ExtrudeGeometry` is not,
  // so any part built from both came out as whichever piece happened to be first: a hood arm as
  // its bare rim, a swerve pod as one fork plate. It has cost two rounds of owner feedback, both
  // times on a build whose whole point was the piece that vanished. Normalizing here makes the
  // mistake unmakeable instead of leaving each caller to remember.
  const parts = built.map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const p of new Set([...built, ...parts])) if (p !== merged) p.dispose();
  FRAME_CACHE.set(key, merged);
  SHARED_GEO.add(merged);
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE DRIVE WHEELS — THE REAL PARTS, MODELLED, AND NOTHING ABOUT THEM PAINTED
// ═══════════════════════════════════════════════════════════════════════════════════════════
/**
 * ⚠️ **THERE USED TO BE A SLANTED-STRIPE `CanvasTexture` ON EVERY ROLLER WHEEL, AND IT WAS WRONG
 * ON MORE DRIVETRAINS THAN IT WAS RIGHT ON** (owner, 2026-09-21: "Make the wheels be rendered
 * accurately. Gobilda 104mm gripforce mecanum wheel, gobilda omni wheel"; then, on the shipped
 * picture, "it makes no sense for the wheel to have slant patterns" / "which is how it is right
 * now").
 *
 * One 64×64 canvas of diagonal lines was stretched over a bare `CylinderGeometry` and handed to
 * MECANUM, to an X-drive's OMNIS and to a BUTTERFLY's corner set. A 45° slant is a statement
 * about HARDWARE — it is the roller axis of a mecanum wheel and of nothing else — so painting it
 * on an omni claimed a wheel that slides along its own rim, which is the opposite of what a
 * tangential roller does. The drawing could not be fixed by choosing better stripes, because the
 * thing being drawn was not a wheel.
 *
 * So every drive wheel is MODELLED from the manufacturer's published dimensions instead, and it
 * is modelled at BOTH detail levels: the SHAPE never changes with the graphics preset, only the
 * tessellation does (`BbWheelDetail`, `WHEEL_LOD`). Low still gets eleven real barrel rollers on
 * real 45° axles — just five-sided ones. A tier has never been a reason to lie about the machine.
 *
 * ── WHAT EACH DRIVETRAIN CARRIES, AND WHY ──────────────────────────────────────────────────
 *   MECANUM / BUTTERFLY's corner set — goBILDA 104 mm GripForce Mecanum, handed per corner.
 *   X-DRIVE                          — goBILDA 96 mm Omni, the largest omni goBILDA sells.
 *   TANK / BUTTERFLY's inboard set   — goBILDA 96 mm Hogback Traction.
 *   SWERVE pod                       — goBILDA 72 mm Hogback Traction (a pod has 4.34 in of
 *                                      headroom under the deck; see `BB_POD_WHEEL_R`).
 *
 * ⚠️ **NOTHING HERE IS READ BY THE SIM**, exactly as before — this block is geometry. The one
 * number that now agrees with the sim rather than merely sitting near it is the mecanum
 * DIAMETER: `C.WHEEL_DIAMETER_MM` is 104, the figure `C.SPEED_PER_RPM` derives the drivetrain's
 * top speed from, and the drawn wheel was a typed 4.00 in (101.6 mm) beside it. It is the same
 * 104 mm wheel in both places now.
 */
const MM = 1 / 25.4;

/**
 * ONE WHEEL AS THE CATALOGUE SELLS IT. Every field is either PUBLISHED (cited at the constant
 * that fills it) or DERIVED from published ones; nothing is styled. `rollers: 0` is a plain
 * traction tyre, which is the absence of the whole roller mechanism rather than a variant of it.
 */
interface BbWheelPart {
  /** outer radius — half the published diameter. */
  r: number;
  /** overall width across the wheel, outside face to outside face. */
  w: number;
  /** rollers per ROW. A mecanum has one row; an omni has two, staggered half a pitch. */
  rollers: number;
  rows: number;
  /** the angle between a roller's OWN axis and the WHEEL's axle: 45° mecanum, 90° omni. */
  rollerAngle: number;
  /** the roller's radius at its waist, and its length along its own axis. */
  rollerR: number;
  rollerL: number;
  /** side/core plate thickness and outer radius. */
  plateT: number;
  plateR: number;
}

// ── goBILDA 104 mm GripForce Mecanum Wheel, SKU 3625-0202-0104 ───────────────────────────────
// PUBLISHED (gobilda.com product page): "Ø104mm"; "The 11 rollers deliver an incredibly smooth
// ride while minimizing wheel width"; "40A Durometer Silicone Rubber Rollers"; "steel side
// plates"; "236g Each"; sold as a four-wheel SET (two left-slant, two right-slant).
// The 45° roller axis is not spelled out by goBILDA and does not need to be: it is the definition
// of a mecanum wheel, and AndyMark states it for the equivalent part ("Angle: 45 degrees
// (standard for mecanum design)").
const BB_MEC_R = (104 * MM) / 2;
/** rollers per wheel — PUBLISHED, the one roller count in this file that is not a choice. */
const BB_MEC_ROLLERS = 11;
/** steel, so THIN. APPROX: goBILDA publishes no plate thickness; 1.5 mm is ordinary sheet. */
const BB_MEC_PLATE_T = 1.5 * MM;
/**
 * the roller's waist radius. ⚠️ APPROX, but BOUNDED, not picked: eleven parallel 45° rollers on a
 * Ø104 rim sit `2ρ·sin(π/11)·cos45°` apart measured PERPENDICULAR to their own axes, so anything
 * at or past half of that makes the neighbours interpenetrate — the ceiling is 0.346 in and this
 * is 0.31, which leaves the 0.07-in daylight a real wheel has. `mecanumChecks` re-derives it.
 */
const BB_MEC_ROLLER_R = 0.31;
/**
 * ⚠️ **goBILDA PUBLISHES NO WIDTH FOR THIS WHEEL, AND 48 mm IS DERIVED RATHER THAN GUESSED.** A
 * mecanum's rollers have to OVERLAP in azimuth or the wheel drops into a gap between them once a
 * revolution; each roller covers `rollerL·sin45°` of circumference against a pitch of `2πρ/11`,
 * and the width is what sets `rollerL`. 48 mm puts that overlap at 1.68×, which is the ordinary
 * figure for a mecanum of this size — 37 mm would be the bare minimum (overlap exactly 1.0) and
 * is visibly too narrow. APPROX, and flagged as such wherever it is used.
 */
const BB_MEC_W = 48 * MM;
const BB_MECANUM: BbWheelPart = {
  r: BB_MEC_R,
  w: BB_MEC_W,
  rollers: BB_MEC_ROLLERS,
  rows: 1,
  rollerAngle: Math.PI / 4,
  rollerR: BB_MEC_ROLLER_R,
  // the roller spans the clear width between the two plates, at 45°, so its AXIAL extent is
  // exactly that clear width — which is what makes a mecanum's tread continuous across its face
  rollerL: (BB_MEC_W - 2 * BB_MEC_PLATE_T - 0.1) * Math.SQRT2,
  plateT: BB_MEC_PLATE_T,
  // the plates carry the roller axles, so they reach a little past the roller centre-line and
  // stop well inside the rolling radius — the rollers are what touches the mat, not the steel
  plateR: BB_MEC_R - BB_MEC_ROLLER_R * 0.65,
};

// ── goBILDA 96 mm Omni Wheel, SKU 3624-0014-0096 ─────────────────────────────────────────────
// PUBLISHED (gobilda.com product page): Ø96 mm; 50A rollers; "The core of the wheel is offset 8mm
// on one side and 12mm on the other"; 14 mm centre thru-hole plus eight 16 mm-pattern and eight
// 32 mm-pattern thru-holes; 119 g.
// ⚠️ **96 mm IS THE LARGEST OMNI goBILDA SELLS** — the catalogue is 32 / 48 / 72 / 96 mm, and
// there is no 104. So an X-drive does NOT ride on the mecanum's rolling radius and must not be
// drawn as if it did: it is 0.157 in smaller in the radius, which is the real trade a team makes.
// The 48 mm is goBILDA's own odometry-pod wheel and the 32 mm is smaller still; 72 mm would fit
// but throws away rolling radius for nothing on a drivetrain this size.
const BB_OMNI_R = (96 * MM) / 2;
/** ⚠️ APPROX — goBILDA publishes no roller count. Nine per row is what the tiling asks for: an
 *  omni's rollers lie END TO END around the rim (their axes ARE the tangent), so the pitch
 *  `2ρ·sin(π/9)` = 1.16 in is the roller length, which at a 0.20-in waist is the stubby barrel
 *  the part actually has. Two rows staggered half a pitch is PUBLISHED, in the offset core. */
const BB_OMNI_ROLLERS = 9;
const BB_OMNI_ROLLER_R = 0.2;
const BB_OMNI_PLATE_T = 0.09;
/** DERIVED, not typed: the two rows sit either side of the core plate and an omni roller's extent
 *  along the AXLE is just its own diameter (its length runs tangentially), so the wheel is exactly
 *  `plate + 4·rollerR` wide — 22.5 mm, which is what a 96 mm omni measures. */
const BB_OMNI_W = BB_OMNI_PLATE_T + 4 * BB_OMNI_ROLLER_R;
const BB_OMNI: BbWheelPart = {
  r: BB_OMNI_R,
  w: BB_OMNI_W,
  rollers: BB_OMNI_ROLLERS,
  rows: 2,
  rollerAngle: Math.PI / 2,
  rollerR: BB_OMNI_ROLLER_R,
  rollerL: 2 * (BB_OMNI_R - BB_OMNI_ROLLER_R) * Math.sin(Math.PI / BB_OMNI_ROLLERS) * 0.92,
  plateT: BB_OMNI_PLATE_T,
  plateR: BB_OMNI_R - BB_OMNI_ROLLER_R + 0.1,
};

// ── goBILDA Hogback Traction Wheels, SKUs 3626-0014-0096 and 3626-0014-0072 ──────────────────
// PUBLISHED (gobilda.com product pages): Ø96 mm / 82 g and Ø72 mm / 55 g, both 50A, both
// "Plastic Core with Rubber Tread" with a bonded silicone tread and a "slight tread crown".
// ⚠️ APPROX: no width is published for either. 32 mm and 28 mm are ordinary for the size, and the
// CROWN is published, so the tyre is a lathe with a crowned profile rather than a cylinder.
const BB_TRACTION_R = (96 * MM) / 2;
const BB_TRACTION_W = 32 * MM;
const BB_POD_TRACTION_R = (72 * MM) / 2;
const BB_POD_TRACTION_W = 28 * MM;
/** how far the crown stands proud of the tyre's own shoulders (in). PUBLISHED as "slight". */
const BB_TREAD_CROWN = 0.05;
function tractionPart(r: number, w: number): BbWheelPart {
  return {
    r,
    w,
    rollers: 0,
    rows: 0,
    rollerAngle: 0,
    rollerR: 0,
    rollerL: 0,
    // the plastic CORE, which on a Hogback is most of the wheel and shows on both faces; the
    // rubber is a bonded band round it
    plateT: w,
    plateR: r * 0.7,
  };
}
const BB_TRACTION = tractionPart(BB_TRACTION_R, BB_TRACTION_W);
const BB_POD_TRACTION = tractionPart(BB_POD_TRACTION_R, BB_POD_TRACTION_W);

export type BbWheelKind = 'mecanum' | 'omni' | 'traction' | 'podTraction';
export const BB_WHEEL_PARTS: Record<BbWheelKind, BbWheelPart> = {
  mecanum: BB_MECANUM,
  omni: BB_OMNI,
  traction: BB_TRACTION,
  podTraction: BB_POD_TRACTION,
};

/**
 * THE WHEEL CHANNEL — sized by the WIDEST wheel any drivetrain puts in it, which is the mecanum.
 *
 * ⚠️ **THERE IS NO `BB_WHEEL_R` ANY MORE, AND ITS ABSENCE IS THE POINT.** A single "the wheel
 * radius" was what let a tank, an X-drive and a swerve pod all be drawn at the mecanum's size;
 * every drivetrain reads its own part out of `BB_WHEEL_PARTS` now, through `wheelKindOf`. What
 * legitimately IS one number is the CHANNEL's width — `BB_PLATE_GAP`, `endWheelSpanY`, the corner
 * end plates — because that is one pocket cut for the biggest thing that goes in it, so a tank's
 * narrower 96 mm Hogback simply has room to spare. Sizing the pocket per drivetrain would make a
 * frame that changes shape when the picker moves, for no gain a camera can see.
 */
const BB_WHEEL_W = BB_MECANUM.w;
/** clear gap between the inner and outer plate: the wheel lives in it, protected. */
const BB_PLATE_GAP = BB_WHEEL_W + 0.4;

/**
 * ⚠️ **THE TIER CHANGES THE TESSELLATION AND NOTHING ELSE** (owner, 2026-09-21: "of course, its
 * fidelity and simplification should depend on graphics settings").
 *
 * Two levels, because the honest question a wheel asks the GPU is "how many sides does a barrel
 * get", and a third answer between five and eight buys nothing measurable. What a level may NOT
 * change is the roller COUNT, the roller ANGLE or the handedness — those are the machine, and a
 * player on Low is looking at the same robot as a player on Ultra.
 */
export type BbWheelDetail = 'low' | 'high';

/**
 * WHICH LEVEL A DEVICE GETS — and it is read off the settings that already exist, because §4.4's
 * table has no room for a seventeenth dial and this does not need one.
 *
 * TWO existing inputs, and each is doing its own job rather than being borrowed:
 *  • **`meshDetail`** is literally "which decimation of the geometry" — the row that already
 *    picks `field.glb` vs `field-low.glb` and the one row the UI already warns needs a rebuild.
 *    Set to `low` by hand on any preset, it means low here too. That is the setting keeping its
 *    promise, not an override.
 *  • **`tier`** is the preset COLUMN, which is how the PIXEL BUDGET is already chosen
 *    (`GFX_PIXEL_BUDGET`) for exactly the reason that applies here: there is no single setting
 *    that separates Medium from High — their sixteen values differ only in AA, shadows and
 *    element shadows, none of which is about mesh density — and Medium is a budget, not a
 *    preference for coarse wheels. So Low and Medium get the cheap tessellation and High and
 *    Ultra the full one, which is the split the request asks for.
 *
 * The REPLAY EXPORT passes a fixed `high` column (`opts.quality`), so an exported frame always
 * gets the full wheel whatever the machine rendering it is set to.
 */
export function bbWheelDetail(settings: Pick<GraphicsSettings, 'meshDetail'>, tier: GraphicsTier): BbWheelDetail {
  if (settings.meshDetail === 'low') return 'low';
  return tier === 'low' || tier === 'medium' ? 'low' : 'high';
}

const WHEEL_LOD: Record<BbWheelDetail, {
  /** sides of a roller barrel, and profile samples along it. */
  rollerSeg: number;
  rollerPts: number;
  /** sides of a plate / tyre lathe, and profile samples across a crowned tyre. */
  plateSeg: number;
  tyrePts: number;
  /** lightening holes in a side plate (0 = a plain disc), and axial tread bars on a tyre. */
  holes: number;
  ribs: number;
}> = {
  low: { rollerSeg: 5, rollerPts: 3, plateSeg: 12, tyrePts: 2, holes: 0, ribs: 0 },
  high: { rollerSeg: 8, rollerPts: 7, plateSeg: 34, tyrePts: 5, holes: 8, ribs: 20 },
};

/**
 * THE BARREL PROFILE OF ONE ROLLER — DERIVED, NOT STYLED.
 *
 * A mecanum or omni roller is neither a cylinder nor an ellipse: its surface has to lie ON the
 * WHEEL's own outer cylinder, or the wheel thumps once per roller. Put the roller's axis `ρ` from
 * the wheel axle and tilt it `α` off it; a point `s` along the roller then sits
 * `hypot(ρ, s·sin α)` from the axle, so the roller's radius there must be `R − hypot(ρ, s·sin α)`.
 * At the waist that is exactly `rollerR` by construction; at the ends it tapers, and by how much
 * is the wheel's arithmetic rather than a taste call. It is also why an omni roller (α = 90°) is
 * the stubbier, more sharply waisted barrel of the two — the taper runs at full rate.
 *
 * The two `0.02` end points are the flat caps: a `LatheGeometry` whose profile does not reach the
 * axis is an open tube, and an open tube's back faces show through the wheel from the far side.
 */
function barrelProfile(part: BbWheelPart, pts: number): THREE.Vector2[] {
  const rho = part.r - part.rollerR;
  const sinA = Math.sin(part.rollerAngle);
  const out: THREE.Vector2[] = [new THREE.Vector2(0.02, -part.rollerL / 2)];
  for (let i = 0; i <= pts; i++) {
    const s = -part.rollerL / 2 + (part.rollerL * i) / pts;
    out.push(new THREE.Vector2(Math.max(0.03, part.r - Math.hypot(rho, s * sinA)), s));
  }
  out.push(new THREE.Vector2(0.02, part.rollerL / 2));
  return out;
}

/**
 * EVERY ROLLER ON ONE WHEEL, placed in the wheel's own frame (axle = local +y, the convention
 * `CylinderGeometry` already uses here so a wheel needs no rotation to face outward).
 *
 * ⚠️ **`hand` IS THE WHOLE OF MECANUM HANDEDNESS, AND THE SIGN IS THE ONE THING TO GET RIGHT.**
 * A roller's axis is `cos α·ŷ − hand·sin α·t̂` — the axle direction, leaned into the circumference
 * one way or the other. The azimuths are phased so a roller sits exactly at TOP DEAD CENTRE,
 * which is both the only roller a top-down camera can see and what `mecanumChecks` measures: at
 * the top, `t̂ = −x̂`, so `hand = +1` points that roller along `(+1, +1)` in the chassis plane —
 * forward-and-left, i.e. a LEFT-slant wheel, which goes at the FRONT-LEFT and REAR-RIGHT corners
 * (AndyMark, on the equivalent part: "right wheels at the FRONT RIGHT and the REAR LEFT position,
 * while the 'left' wheel would be in the FRONT LEFT and REAR RIGHT"; REV: "Following diagonal
 * lines created from the angle of the rollers should form an 'X' … viewed from above").
 * `buildWheels` picks it with `x * sy >= 0 ? 1 : -1`, which is the SAME expression the 2D sprite
 * hatches its rollers by — so the two views cannot disagree about which wheel is which.
 */
function rollerGeometries(part: BbWheelPart, detail: BbWheelDetail, hand: 1 | -1): THREE.BufferGeometry[] {
  const lod = WHEEL_LOD[detail];
  const rho = part.r - part.rollerR;
  const cosA = Math.cos(part.rollerAngle);
  const sinA = Math.sin(part.rollerAngle);
  const profile = barrelProfile(part, lod.rollerPts);
  const out: THREE.BufferGeometry[] = [];
  // the rows sit either side of the core plate; ONE row sits on it
  const rowYs = part.rows > 1 ? [-(part.plateT / 2 + part.rollerR), part.plateT / 2 + part.rollerR] : [0];
  for (let row = 0; row < rowYs.length; row++) {
    // ⚠️ THE SECOND ROW IS STAGGERED HALF A PITCH, which is the entire point of a two-row omni:
    // one row's rollers cover the gaps the other leaves, so the wheel never rolls off the end of
    // a roller onto nothing. Drawing both rows in phase is a wheel with a flat spot.
    const phase = Math.PI / 2 + (row * Math.PI) / part.rollers;
    for (let i = 0; i < part.rollers; i++) {
      const theta = phase + (i * Math.PI * 2) / part.rollers;
      const rx = Math.cos(theta);
      const rz = Math.sin(theta);
      // radial, and the tangent it leans into
      const rad = new THREE.Vector3(rx, 0, rz);
      const tan = new THREE.Vector3(-rz, 0, rx);
      const axis = new THREE.Vector3(0, cosA, 0).addScaledVector(tan, -hand * sinA).normalize();
      const third = new THREE.Vector3().crossVectors(rad, axis);
      const g = new THREE.LatheGeometry(profile, lod.rollerSeg);
      g.applyMatrix4(
        new THREE.Matrix4()
          .makeBasis(rad, axis, third)
          .setPosition(rx * rho, rowYs[row], rz * rho),
      );
      out.push(g);
    }
  }
  return out;
}

/**
 * THE SIDE (or CORE) PLATES — a disc with the hub pattern in it, lying in the wheel's x–z plane.
 *
 * The bore set is goBILDA's own, PUBLISHED for these wheels: a 14 mm centre thru-hole and eight
 * more on the 32 mm pattern. (The 16 mm pattern is published too and is NOT drawn: at 8 mm from
 * the axis its holes overlap the 14 mm bore itself, so at this scale it is a smudge rather than a
 * pattern.) At `low` the holes go and the plate is a plain disc — a hole you cannot resolve is
 * triangles spent on nothing.
 */
function plateGeometries(part: BbWheelPart, detail: BbWheelDetail): THREE.BufferGeometry[] {
  const lod = WHEEL_LOD[detail];
  // ⚠️ `rows === 1` IS THE ONLY TWO-PLATE CASE. A mecanum's rollers hang BETWEEN two side plates;
  // an omni's two rows sit either side of ONE core, and a traction wheel's core IS the wheel. The
  // first cut keyed on `rows > 1` and gave traction two plates at the same y, one inside the other.
  const ys = part.rows === 1 ? [-(part.w / 2 - part.plateT / 2), part.w / 2 - part.plateT / 2] : [0];
  const out: THREE.BufferGeometry[] = [];
  for (const y of ys) {
    let g: THREE.BufferGeometry;
    if (lod.holes > 0) {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, part.plateR, 0, Math.PI * 2, false);
      const bore = new THREE.Path();
      bore.absarc(0, 0, (14 * MM) / 2, 0, Math.PI * 2, true);
      shape.holes.push(bore);
      const boltR = (32 * MM) / 2;
      const holeR = Math.min(0.11, (boltR * Math.PI) / lod.holes / 2.2);
      for (let i = 0; i < lod.holes; i++) {
        const a = (i * Math.PI * 2) / lod.holes;
        const p = new THREE.Path();
        p.absarc(Math.cos(a) * boltR, Math.sin(a) * boltR, holeR, 0, Math.PI * 2, true);
        shape.holes.push(p);
      }
      // ⚠️ `curveSegments` IS PER CURVE, AND AT 5 THE PLATE WAS A PENTAGON-ISH BLOB beside a
      // perfectly round ring of rollers — the one place in this wheel where the tessellation was
      // visibly the wrong shape rather than merely coarse. 12 makes the disc read as a disc at
      // the range the builder's turntable puts a camera at, and it costs the high tier ~500
      // triangles, which is inside the budget the RENDER lane measures.
      const ex = new THREE.ExtrudeGeometry(shape, { depth: part.plateT, bevelEnabled: false, curveSegments: 12, steps: 1 });
      // the same one-line reorientation `platePlane` makes: shape-y → world z, depth → world −y
      ex.rotateX(Math.PI / 2);
      ex.translate(0, part.plateT / 2, 0);
      g = ex;
    } else {
      g = new THREE.CylinderGeometry(part.plateR, part.plateR, part.plateT, lod.plateSeg);
    }
    g.translate(0, y, 0);
    out.push(g);
  }
  return out;
}

/**
 * A TRACTION TYRE — a bonded rubber band on its plastic core, with the published CROWN.
 *
 * The band is a closed lathe section (inner face at the core's own radius, out to a crowned
 * outer face and back), not a cylinder: a cylinder's square shoulders are the reason the old
 * wheel read as a hockey puck. The tread is AXIAL bars — `ribs` of them, running across the roll
 * direction, which is what a traction tread does and the only pattern that may ever appear here.
 * ⚠️ NOTHING ON THIS WHEEL IS SLANTED, at any tier. A slant on a traction wheel is a picture of a
 * mecanum, which is the bug this whole block exists to end.
 */
function tyreGeometries(part: BbWheelPart, detail: BbWheelDetail): THREE.BufferGeometry[] {
  const lod = WHEEL_LOD[detail];
  const hw = part.w / 2;
  const ri = part.plateR;
  const pts: THREE.Vector2[] = [new THREE.Vector2(ri, -hw)];
  for (let i = 0; i <= lod.tyrePts; i++) {
    const t = -1 + (2 * i) / lod.tyrePts;
    pts.push(new THREE.Vector2(part.r - BB_TREAD_CROWN * t * t, t * hw));
  }
  pts.push(new THREE.Vector2(ri, hw), new THREE.Vector2(ri, -hw));
  const out: THREE.BufferGeometry[] = [new THREE.LatheGeometry(pts, lod.plateSeg)];
  for (let i = 0; i < lod.ribs; i++) {
    const a = (i * Math.PI * 2) / lod.ribs;
    const bar = new THREE.BoxGeometry(0.09, part.w * 0.84, 0.15);
    // ⚠️ SET IN FAR ENOUGH THAT NO CORNER OF THE BAR CROSSES THE PUBLISHED DIAMETER. A bar centred
    // at `r − 0.035` puts its outer face at `r + 0.010`: 0.011 in proud of the tyre, which the
    // "stays inside its own published diameter" and "nothing is below the floor" checks both
    // caught — the same 0.011 in, once as an oversized wheel and once as a wheel dug into the mat.
    bar.translate(part.r - 0.06, 0, 0);
    bar.rotateY(-a);
    out.push(bar);
  }
  return out;
}

/**
 * ONE DRIVE WHEEL, as a `THREE.Group` so the whole assembly takes one `rotation.y` and the
 * rollers sweep WITH it — which is the other half of getting handedness right, and something a
 * painted texture could never do at all.
 *
 * Two meshes, because a steel plate and a silicone roller are two materials and the contrast
 * between them is most of what makes the part legible; both geometries come from `framePart`, so
 * every wheel of a kind on every robot on the field shares the same two buffers. `accent` tints
 * the RUBBER (the roller barrels, the tyre band) and leaves the metal alone — the same split the
 * 2D sprite makes, and `tint3d(TREAD, TREAD, x) === TREAD` keeps the default a byte-for-byte
 * no-op for callers that predate cosmetics.
 */
export function buildDriveWheel(
  kind: BbWheelKind,
  detail: BbWheelDetail = 'high',
  accent: string = TREAD,
  hand: 1 | -1 = 1,
): THREE.Group {
  const part = BB_WHEEL_PARTS[kind];
  const g = new THREE.Group();
  /**
   * ⚠️ `ZYX`, AND AN X-DRIVE IS WHY. A `THREE.Euler` defaults to `XYZ`, i.e. `R = Rx·Ry·Rz`, so
   * the `rotation.z` an X-drive cants its wheels by would be applied BEFORE the `rotation.y` the
   * sync rolls them by — and the roll would then be about the CHASSIS's vertical-ish axis rather
   * than about the wheel's own canted axle, which reads as a wheel skidding sideways on the spot.
   * `ZYX` puts the roll inside the cant. It is the same class of bug as the turret's two nodes
   * (`bb-turret-head` / `bb-turret-pitch`), which this repo has already paid for once.
   */
  g.rotation.order = 'ZYX';
  const rubber = solidMat(tint3d(TREAD, accent, 0.45), 0.95, 0);
  // goBILDA's own word for this wheel's plates is "steel", so they are rougher and far more
  // metallic than the extruded-aluminium tone the frame uses
  const steel = solidMat(ALU, 0.35, 0.7);
  if (part.rollers > 0) {
    const rollers = framePart(`wheel:${kind}:rollers:${detail}:${hand}`, () => rollerGeometries(part, detail, hand));
    const plates = framePart(`wheel:${kind}:plates:${detail}`, () => plateGeometries(part, detail));
    const rm = cast(new THREE.Mesh(rollers, rubber));
    rm.name = 'bb-wheel-rollers';
    g.add(rm);
    const pm = cast(new THREE.Mesh(plates, steel));
    // ⚠️ NAMED, AND NOT FOR THIS FILE'S BENEFIT. `podChecks` (RENDER lane) picks the swerve fork
    // out of a pod by "the first mesh with no name", which was true while the pod's only other
    // meshes were the named tyre and hub. A wheel that adds an anonymous mesh of its own would
    // silently become "the fork" and the whole silhouette measurement would move to it.
    pm.name = 'bb-wheel-plates';
    g.add(pm);
  } else {
    const tyre = framePart(`wheel:${kind}:tyre:${detail}`, () => tyreGeometries(part, detail));
    const core = framePart(`wheel:${kind}:core:${detail}`, () => plateGeometries(part, detail));
    const tm = cast(new THREE.Mesh(tyre, rubber));
    tm.name = 'bb-wheel-tread';
    g.add(tm);
    const cm = cast(new THREE.Mesh(core, steel));
    cm.name = 'bb-wheel-core';
    g.add(cm);
  }
  return g;
}

/** shared wheel geometry, one per (radius, width, segments) — four to six per robot, identical. */
const WHEEL_GEO_CACHE = new Map<string, THREE.CylinderGeometry>();
function wheelGeometry(r: number, w: number): THREE.CylinderGeometry {
  const key = `${r}|${w}`;
  const hit = WHEEL_GEO_CACHE.get(key);
  if (hit) return hit;
  const geo = new THREE.CylinderGeometry(r, r, w, 14);
  WHEEL_GEO_CACHE.set(key, geo);
  SHARED_GEO.add(geo);
  return geo;
}

/**
 * WHEEL AXLE POSITIONS along the chassis, by drivetrain. TANK is a six-wheel drop-centre — the
 * shape every kit builds and the one `presets.ts` describes in words — so it gets three axles a
 * side; everything else gets the four corners.
 */
function axleXs(spec: RobotSpec): number[] {
  // the END axle is set in by the wheel THIS drivetrain carries, not by the channel's own
  // mecanum: a tank's 96 mm Hogback is 0.157 in smaller in the radius and sits that much further
  // out, which is where a real six-wheel drop-centre puts it
  const end = spec.length / 2 - BB_WHEEL_PARTS[wheelKindOf(spec.drivetrain)].r - 0.7;
  if (spec.drivetrain === 'tank') return [end, 0, -end];
  return [end, -end];
}

/**
 * WHICH REAL PART A DRIVETRAIN RUNS. The one place the mapping is written, read by `buildWheels`,
 * by `axleXs`, by the X-drive insets and by the RENDER lane — so "an X-drive is on omnis" is a
 * fact with one home rather than a branch repeated at four call sites.
 *
 * BUTTERFLY answers `mecanum` because that is its CORNER set, the one on the axle line the
 * channel and the end plates are cut for; its inboard traction twin is placed off `traction`
 * explicitly in `buildWheels`.
 */
export function wheelKindOf(dt: RobotSpec['drivetrain']): BbWheelKind {
  if (dt === 'xdrive') return 'omni';
  if (dt === 'tank') return 'traction';
  if (dt === 'swerve') return 'podTraction';
  return 'mecanum';
}

/**
 * ⚠️ AN X-DRIVE OMNI DOES NOT LIVE IN THE WHEEL CHANNEL EITHER (owner, 2026-09-19: "selecting x
 * drive makes the wheels stick out of the robot"). Canted 45°, a wheel `2R` long and `W` wide
 * reaches `(2R + W) / (2·√2)` along BOTH chassis axes, and the channel's centre-line is only
 * 1.17 in inside the frame — so every wheel stood 0.78 in proud of its side plate. Same fix as
 * the swerve pod: inset the wheel from both faces by its own canted reach, past the side plate
 * laterally and past the cross member fore-and-aft (the rail's underside is below the wheel's
 * crown), and `buildFrame` drops the inner side plate, which would otherwise run through it.
 *
 * ⚠️ IT IS THE OMNI'S REACH, NOT THE MECANUM'S. The formula was `BB_WHEEL_R`/`BB_WHEEL_W` — the
 * channel's mecanum — and an X-drive has never had a mecanum in it. On the real part (goBILDA's
 * 96 mm omni, 22.5 mm wide against the mecanum's 48) the reach is 1.650 in rather than the old
 * 1.945, so the wheels tuck FURTHER inside the frame than the rule they were checked against.
 */
const BB_XDRIVE_REACH = (2 * BB_OMNI.r + BB_OMNI.w) / (2 * Math.SQRT2);
const BB_XDRIVE_CLEAR = 0.15;
export const BB_XDRIVE_INSET_X = BB_XDRIVE_REACH + BB_RAIL_T + BB_XDRIVE_CLEAR;
export const BB_XDRIVE_INSET_Y = BB_XDRIVE_REACH + BB_PLATE_T + BB_XDRIVE_CLEAR;

// ── SWERVE POD DIMENSIONS (in). GEOMETRY, not physics: the sim has no pod. ───────────────────
/**
 * ⚠️ A POD IS 3-IN WHEELED, NOT 4-IN, AND THE DECK IS WHY (owner, 2026-09-19: swerve protrudes
 * outside the chassis and the module is a box). The whole pod has to live UNDER the deck plate —
 * `[0, BB_DECK_Z − 0.26]` = 4.34 in of headroom — and a 4-in wheel leaves 0.34 in of that for the
 * top plate, the azimuth bearing and the drive, which is why the slew ring ended up standing 1.13
 * in ABOVE the deck, through the structure it is supposed to hang from. A 3-in wheel is what COTS
 * FTC swerve modules actually run, and it makes the stack close: wheel [0, 3.00], fork plates
 * [0.40, 3.60], top plate [3.60, 3.90], slew ring [3.90, 4.34].
 *
 * ⚠️ AND IT IS A REAL 72 mm PART, NOT A TYPED 3.00. goBILDA's catalogue has no 3-in wheel: the
 * size below the 96 mm the rest of the drivetrains run is the **72 mm Hogback Traction Wheel**
 * (SKU 3626-0014-0072, 50A, 55 g), which is 2.835 in — inside the 3.00 the stack above was sized
 * for, so every clearance in that paragraph gets 0.165 in BETTER and nothing above the wheel
 * moves. Everything in the pod is derived from this constant, so the fork boss, the kingpin and
 * the belt's lower pulley all followed it down on their own.
 */
const BB_POD_WHEEL_R = BB_POD_TRACTION.r;
/** the pod's tyre is that same part's width — the fork is built around the wheel, not around the
 *  mecanum channel's 48 mm, which is what `BB_POD_FORK_Y` used to read. */
const BB_POD_WHEEL_W = BB_POD_TRACTION.w;
/** thickness of the fork plate either side of the wheel, and the clearance out to it. */
const BB_POD_FORK_T = 0.22;
/**
 * ⚠️ **THE FORK PLATE IS SHORTER THAN THE WHEEL, AND IT NARROWS TO A BOSS AT THE AXLE** (owner,
 * 2026-09-19: "the swerve wheel has two rectangular plates blocking the wheel, so it looks like it
 * is just a rectangular cylinder as the wheel — remove those plates or make it smaller").
 *
 * It was a 3.2 × 3.5 rectangle standing either side of a 3.0-in wheel, from 0.40 up to the top
 * plate: in side view it covered the wheel completely, top to bottom and end to end, so the only
 * thing left of the wheel was a dark band under the plate's bottom edge. That is the "rectangular
 * cylinder". A real fork is a bearing carrier, not a shroud — it hangs off the top plate and
 * tapers to a boss around the axle — so it is one now: `BB_POD_FORK_L` long at the top and
 * `BB_POD_FORK_BOSS_R` at the bottom, which leaves the tyre's whole lower half and both ends of
 * its circle in plain sight, with the hub showing as a ring around the boss.
 */
const BB_POD_FORK_L = 2.1;
const BB_POD_FORK_BOSS_R = 0.45;
/** the wheel's own hub, drawn a whisker proud of the tyre on both faces so it reads through the
 *  gap the fork's boss leaves. Bigger than the boss, or there would be nothing to see. */
const BB_POD_HUB_R = 0.72;
/** the toothed steering ring / pulley the pod is slewed by. */
const BB_POD_RING_R = 1.25;
const BB_POD_RING_H = 0.44;
/** how far proud of the race the toothed flange stands — what makes the ring read as a pulley
 *  being driven rather than as another puck. */
const BB_POD_RING_FLANGE = 0.15;
/** the pod's top plate, UNDER the ring, which is in turn under the deck plate's own underside. */
const BB_POD_PLATE_Z = BB_DECK_Z - 0.26 - BB_POD_RING_H;
/** where each fork plate's mid-plane sits either side of the wheel. */
const BB_POD_FORK_Y = BB_POD_WHEEL_W / 2 + 0.2;
/** the pod's drive: a pulley on the wheel axle and a second at the top plate, with a belt
 *  between them down the OUTBOARD face of one fork plate. This is the one part the pod was
 *  missing that says the wheel is DRIVEN as well as steered, and it costs one merged geometry
 *  shared by all four corners. */
const BB_POD_PULLEY_R = 0.45;
const BB_POD_DRIVE_T = 0.2;
/** the pod's box in plan — the fork's length, and the full width out to the drive belt. Both
 *  feed `BB_POD_INSET`, so a wider pod tucks itself further inside the frame automatically. */
const BB_POD_L = 3.2;
const BB_POD_W = (BB_POD_FORK_Y + BB_POD_FORK_T / 2 + BB_POD_DRIVE_T) * 2;
/**
 * ⚠️ HOW FAR IN FROM EACH FRAME FACE A POD MUST SIT, AND WHY IT IS NOT THE WHEEL CHANNEL.
 *
 * A pod slews. A box `BB_POD_L × BB_POD_W` rotated about its own centre has a worst-case
 * half-extent of `hypot(L, W) / 2` on EITHER axis, so that — or the slew ring's flange, whichever
 * is larger — is the inset from each frame face. The pods used to sit in the wheel channel at
 * `hw − 1.17` against a requirement of 1.94, which measured +0.46 in outside the frame at rest
 * (the ring) and +0.88 at 45° of steer (the fork box). A wheel may REACH the frame edge; nothing
 * may cross it, because `chassis3dShapes` gives the physics a flat frame face there and a mesh
 * claiming solid the collider does not have is this repo's recurring bug.
 */
const BB_POD_INSET = Math.max(Math.hypot(BB_POD_L, BB_POD_W) / 2, BB_POD_RING_R + BB_POD_RING_FLANGE);
/* ⚠️ NO MOTOR ON TOP OF THE POD (owner, 2026-09-19: "the motor for swerve does NOT go on top of
 * the swerve module"). A first pass stood a can on the slew ring; that is not where a swerve
 * steering motor lives. It sits on the DECK and drives the ring through the belt or gear the ring
 * is toothed for, so the pod carries the ring and nothing above it. The ring is what says the pod
 * is STEERED; the belt down the fork below is what says the wheel is also DRIVEN. */
/**
 * how far a BUTTERFLY lifts the set that is off the ground (in).
 *
 * ⚠️ **THE DECK IS THE CEILING, AND IT BECAME BINDING WHEN THE WHEEL BECAME 104 mm.** A typed 0.6
 * put the lifted mecanum's crown at `2 × 2.047 + 0.6` = 4.694, through a deck plate whose
 * underside is at `BB_DECK_Z − 0.26` = 4.34 and whose top face is 4.60 — a wheel poking out of the
 * lid the owner had made full-footprint the day before. On the old 4.00-in wheel it landed exactly
 * on 4.60 and got away with it. Derived against the deck now, so a future wheel change cannot
 * reintroduce it: the lift is whatever headroom the TALLEST set has left, capped at the 0.6 this
 * always wanted.
 */
const BB_BUTTERFLY_LIFT = Math.min(0.6, BB_DECK_Z - 0.26 - 2 * BB_MECANUM.r);

/**
 * ONE SWERVE POD'S HARDWARE, in the pod's own frame: origin at the wheel's contact patch, +x the
 * rolling direction, +z up. Three merged geometries because they are three materials; every pod
 * on every robot shares all three, so four corners cost six draw calls and not twenty-four.
 *
 * ⚠️ THE POD'S ORIGIN IS THE CONTACT PATCH, WHICH IS THE STEERING AXIS. That is the whole reason
 * this is a group and not four loose meshes: a swerve module slews about a vertical kingpin
 * through the patch (zero scrub radius), so `group.rotation.z = steer` is the real motion and
 * the wheel, the fork, the ring and the motor all go round together. The old drawing was a
 * 2.2-in puck floating at deck height with the wheel left behind pointing forward — it could not
 * turn, and nothing about it said "module".
 */
function podParts(): THREE.Object3D[] {
  const forkY = BB_POD_FORK_Y;
  const struct = framePart('swervePod:struct', () => {
    const parts: THREE.BufferGeometry[] = [];
    // TWIN FORK PLATES carrying the axle, one either side of the wheel. Each is a plate hanging
    // off the top plate and TAPERING to a boss around the axle — see `BB_POD_FORK_L`. Built in
    // shape space (u = along, v = up) and rotated once, the same way `platePlane` is.
    const halfL = BB_POD_FORK_L / 2;
    const topZ = BB_POD_PLATE_Z - 0.3;
    for (const s of [1, -1] as const) {
      // wound CCW, like `platePlane`'s: a reversed outline extrudes with its caps facing inward
      // and a single-sided material then draws nothing at all where the plate should be
      const shape = new THREE.Shape();
      shape.moveTo(halfL, topZ);
      shape.lineTo(-halfL, topZ);
      // down the leading edge to the boss, round its underside, and back up the trailing edge
      shape.absarc(0, BB_POD_WHEEL_R, BB_POD_FORK_BOSS_R, Math.PI, 0, false);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: BB_POD_FORK_T, bevelEnabled: false, curveSegments: 12 });
      g.rotateX(Math.PI / 2);
      g.translate(0, s * forkY + BB_POD_FORK_T / 2, 0);
      parts.push(g);
    }
    // THE TOP PLATE the fork hangs off
    parts.push(boxAt(BB_POD_L, forkY * 2 + BB_POD_FORK_T, 0.3, 0, 0, BB_POD_PLATE_Z - 0.15));
    // THE KINGPIN — the vertical steering axis itself, through the contact patch. It shows in
    // the gap between the wheel's crown and the top plate, which is the only place it can.
    const pin = new THREE.CylinderGeometry(0.28, 0.28, BB_POD_PLATE_Z - 0.3 - BB_POD_WHEEL_R * 2, 8);
    pin.rotateX(Math.PI / 2);
    pin.translate(0, 0, (BB_POD_WHEEL_R * 2 + BB_POD_PLATE_Z - 0.3) / 2);
    parts.push(pin);
    return parts;
  });
  const ringZ = BB_POD_PLATE_Z + BB_POD_RING_H / 2;
  const ring = framePart('swervePod:ring', () => {
    const parts: THREE.BufferGeometry[] = [];
    const race = new THREE.CylinderGeometry(BB_POD_RING_R, BB_POD_RING_R, BB_POD_RING_H, 20);
    race.rotateX(Math.PI / 2);
    race.translate(0, 0, ringZ);
    parts.push(race);
    // the TOOTHED flange — a thin disc a little proud of the race, which is what makes the ring
    // read as a pulley being driven rather than as another puck
    const flange = new THREE.CylinderGeometry(
      BB_POD_RING_R + BB_POD_RING_FLANGE,
      BB_POD_RING_R + BB_POD_RING_FLANGE,
      0.15,
      20,
    );
    flange.rotateX(Math.PI / 2);
    flange.translate(0, 0, ringZ + BB_POD_RING_H / 2 - 0.075);
    parts.push(flange);
    return parts;
  });
  // THE BELT DRIVE, down the outboard face of one fork plate: a pulley on the wheel's own axle,
  // a second under the top plate, and the belt between them. Without it the pod is a steered
  // caster, which is not what a swerve module is.
  const driveY = forkY + BB_POD_FORK_T / 2 + BB_POD_DRIVE_T / 2;
  const topZ = BB_POD_PLATE_Z - 0.3 - BB_POD_PULLEY_R - 0.05;
  const drive = framePart('swervePod:drive', () => {
    const parts: THREE.BufferGeometry[] = [];
    for (const z of [BB_POD_WHEEL_R, topZ]) {
      const p = new THREE.CylinderGeometry(BB_POD_PULLEY_R, BB_POD_PULLEY_R, BB_POD_DRIVE_T, 12);
      p.translate(0, driveY, z);
      parts.push(p);
    }
    for (const s of [1, -1] as const) {
      parts.push(
        boxAt(0.14, BB_POD_DRIVE_T, topZ - BB_POD_WHEEL_R, s * BB_POD_PULLEY_R, driveY, (topZ + BB_POD_WHEEL_R) / 2),
      );
    }
    return parts;
  });
  return [
    cast(new THREE.Mesh(struct, solidMat(ALU, 0.45, 0.35))),
    cast(new THREE.Mesh(ring, solidMat(TURRET_RING, 0.4, 0.5))),
    cast(new THREE.Mesh(drive, solidMat(SWEEPER, 0.6, 0.2))),
  ];
}

/**
 * ONE WHOLE SWERVE POD — the wheel, its hub and the hardware above them, in the pod's own frame.
 *
 * ⚠️ THE WHEEL IS PLAIN TRACTION, NOT A ROLLER WHEEL. Every pod used to take the shared MECANUM
 * material because the wheel loop picks one material for the whole drivetrain, so a swerve robot
 * drove on four 45°-striped mecanums inside its four modules. A swerve pod runs a traction wheel;
 * the stripes were also most of what made the tyre hard to read as a circle.
 *
 * EXPORTED for `scripts/smoke-biobuzz/render.ts`, which builds one and MEASURES it — the same
 * bargain `buildTurret` makes, and for the same reason: the complaint this answers ("it looks like
 * a rectangular cylinder") is about a silhouette, and a lane that greps cannot see one.
 *
 * `accent` (the cosmetic accent) tints the tyre; it defaults to `TREAD` — `tint3d(TREAD, TREAD, x)
 * === TREAD` — so the RENDER lane's existing no-argument call is unchanged.
 */
export function buildSwervePod(accent: string = TREAD, detail: BbWheelDetail = 'high'): THREE.Group {
  const pod = new THREE.Group();
  // ⚠️ A GROUP, NOT A MESH, AND THE NAME MOVED WITH IT. The tyre is `buildDriveWheel`'s real
  // 72 mm Hogback now — a crowned rubber band with axial tread on its plastic core, which is two
  // meshes — so `bb-pod-wheel` names the assembly. Anything measuring it wants a `Box3` over the
  // node, which `setFromObject` gives for a group exactly as it did for the cylinder.
  const wheel = buildDriveWheel('podTraction', detail, accent);
  wheel.name = 'bb-pod-wheel';
  wheel.position.set(0, 0, BB_POD_WHEEL_R);
  pod.add(wheel);
  // the HUB, a whisker proud of the tyre on both faces so it reads as a ring around the fork's
  // boss rather than disappearing behind it
  const hub = new THREE.Mesh(wheelGeometry(BB_POD_HUB_R, BB_POD_WHEEL_W + 0.14), solidMat(ALU, 0.4, 0.5));
  hub.name = 'bb-pod-hub';
  hub.position.set(0, 0, BB_POD_WHEEL_R);
  pod.add(cast(hub));
  for (const p of podParts()) pod.add(p);
  return pod;
}

/** what `buildWheels` hands back to `buildRobotGroup`: the meshes to add, plus the handles the
 * per-frame sync needs to POSE a drivetrain that moves. */
interface BbWheels {
  nodes: THREE.Object3D[];
  /** SWERVE: the four pod groups in `moduleAngles` order — [FL, FR, BL, BR]. */
  pods: THREE.Group[];
  /** BUTTERFLY: the two wheel sets, so the sync can drop whichever one is down. Each carries its
   *  OWN grounded centre height, because the two sets are two different parts now — a 104 mm
   *  mecanum at the corners and a 96 mm Hogback inboard — and one `BB_WHEEL_R` for both would
   *  bury the smaller one 0.157 in in the tiles. */
  traction: BbLiftSet[];
  roller: BbLiftSet[];
  /** every wheel that TURNS with the drive, and the rolling radius to turn it at. */
  spin: BbSpinWheel[];
}
interface BbLiftSet {
  node: THREE.Object3D;
  /** centre height with this set on the floor. */
  z: number;
}
interface BbSpinWheel {
  node: THREE.Object3D;
  r: number;
}

/**
 * DRIVETRAIN-STYLED WHEELS, BETWEEN THE PLATES (owner playtest #16, and swerve 2026-09-19).
 *
 * `RobotSpec.drivetrain` is one of `mecanum | tank | swerve | xdrive | butterfly` (`types.ts`) —
 * geometry only, no physics consequence — and ALL FIVE carry a different REAL PART now
 * (`wheelKindOf`, `BB_WHEEL_PARTS`); none of them carries a painted stripe:
 *  • TANK — six goBILDA 96 mm Hogback traction wheels, three a side, crowned rubber on a
 *    plastic core with AXIAL tread bars. Nothing on it is slanted.
 *  • MECANUM — four goBILDA 104 mm GripForce mecanums: eleven modelled barrel rollers on 45°
 *    axles between two steel side plates, HANDED per corner so the four form the X.
 *  • X-DRIVE — four goBILDA 96 mm omnis, two staggered rows of nine tangential barrels each,
 *    canted ±45° ACROSS their corners.
 *  • SWERVE — four full modules on 72 mm Hogbacks: wheel in a twin-plate fork, kingpin, ring.
 *  • BUTTERFLY — BOTH sets on each side, mecanum at the corners and traction inboard, with the
 *    one that is up visibly lifted.
 *
 * ⚠️ **THE ONLY 45° IN THIS FILE IS A MECANUM ROLLER** (owner, 2026-09-21: "it makes no sense for
 * the wheel to have slant patterns"). It used to be a texture, and the texture went on three of
 * the five. A slant is hardware — see `BB_WHEEL_PARTS`'s header.
 *
 * ⚠️ X-DRIVE AND BUTTERFLY USED TO FALL THROUGH TO THE MECANUM WHEEL, AND ONE OF THOSE WAS A
 * BUG WHILE THE OTHER WAS ONLY THIN. X-drive was wrong in a way the 2D map already disagreed
 * with: `drawWheels` cants its omnis `px * py >= 0 ? -45° : +45°`, so the four of them read as
 * the sides of a DIAMOND, and its header explains why (a wheel whose force line passes through
 * the centre of mass has no moment arm about it, so a radial X could never yaw). Drawing them
 * pointing forward in 3D made the same robot a different machine depending on which key you had
 * pressed. THE CANT RULE HERE IS THAT SAME EXPRESSION, deliberately. Butterfly was merely
 * under-drawn: it really does carry a mecanum set, and `RobotState.butterflyTank` — runtime
 * state that nothing in 3D was reading — says which set is on the ground.
 *
 * Every wheel sits at `y = ±(width/2 − plate − gap/2)`, i.e. in the channel between the inner
 * and outer side plate, which is what "wheels protected between parallel plates" means.
 */
export function buildWheels(spec: RobotSpec, accent: string = TREAD, detail: BbWheelDetail = 'high'): BbWheels {
  const out: BbWheels = { nodes: [], pods: [], traction: [], roller: [], spin: [] };
  const wheelY = spec.width / 2 - BB_PLATE_T - BB_PLATE_GAP / 2;
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const dt = spec.drivetrain;
  const kind = wheelKindOf(dt);
  const part = BB_WHEEL_PARTS[kind];
  for (const x of axleXs(spec)) {
    for (const sy of [1, -1] as const) {
      if (dt === 'swerve') {
        // ── ORDER MATTERS. `axleXs` yields [+x, −x] and the inner loop [+y, −y], so the pods
        // come out FL, FR, BL, BR — the corner order `RobotState.moduleAngles` is documented in
        // and the order `drawWheels` reads it in. Two orders would put a pod's steer on the
        // diagonally opposite corner, which is invisible driving straight and obvious in a spin.
        //
        // ⚠️ A POD DOES NOT LIVE IN THE WHEEL CHANNEL. It is inset `BB_POD_INSET` from BOTH
        // frame faces, which is the only placement that keeps every corner of a SLEWING box
        // inside the frame; `wheelY` (the channel between the two side plates) measured +0.88 in
        // outside it at 45° of steer. `buildFrame` drops the inner side plate for swerve to make
        // room, because a chassis on pods has no wheel channel to draw.
        const pod = buildSwervePod(accent, detail);
        pod.name = `robot:pod:${out.pods.length}`;
        pod.position.set((Math.sign(x) || 1) * (hl - BB_POD_INSET), sy * (hw - BB_POD_INSET), 0);
        out.nodes.push(pod);
        out.pods.push(pod);
        const podWheel = pod.getObjectByName('bb-pod-wheel');
        if (podWheel) out.spin.push({ node: podWheel, r: BB_POD_WHEEL_R });
        continue;
      }
      /**
       * ⚠️ HANDEDNESS. `x * sy >= 0` is the MAIN diagonal — front-left and rear-right — and it is
       * the same expression the 2D sprite hatches its mecanum rollers by and the same one the
       * X-drive cant below uses, deliberately: three renderings of one machine, one predicate.
       * `hand: 1` builds a LEFT-slant wheel (see `rollerGeometries`), which is the wheel that
       * belongs at those two corners, so the four top rollers lie along the two diagonals and
       * form the X. A wheel is `hand`-keyed in `framePart`, so the left pair and the right pair
       * share one buffer each rather than four.
       *
       * It is inert for every other drivetrain — an omni and a traction wheel have no handedness
       * at all — and passing it anyway keeps the placement loop one loop.
       */
      const hand: 1 | -1 = x * sy >= 0 ? 1 : -1;
      // the wheel's axle is its local Y (the `CylinderGeometry`/`LatheGeometry` convention this
      // file builds every round part on), which is chassis left-right — so a wheel needs no
      // rotation to face outward, and `rotation.y` is its roll.
      const wheel = buildDriveWheel(kind, detail, accent, hand);
      wheel.name = `robot:wheel:${out.spin.length}`;
      wheel.position.set(x, sy * wheelY, part.r);
      out.spin.push({ node: wheel, r: part.r });
      if (dt === 'xdrive') {
        // at the CORNER, inset by the canted wheel's own reach — see `BB_XDRIVE_INSET_X`
        wheel.position.x = (Math.sign(x) || 1) * Math.max(0.5, hl - BB_XDRIVE_INSET_X);
        wheel.position.y = sy * Math.max(0.5, hw - BB_XDRIVE_INSET_Y);
        wheel.rotation.z = x * sy >= 0 ? -Math.PI / 4 : Math.PI / 4;
      }
      out.nodes.push(wheel);
      if (dt === 'butterfly') {
        // the MECANUM set is the corner set; the TRACTION set is a real 96 mm Hogback inboard on
        // its own axle — narrower AND smaller in the radius, so the two read as two different
        // parts rather than as one fat wheel. `butterflyTank` decides which one is down — the
        // sync does that, so a preview shows the spawn default (mecanum down).
        out.roller.push({ node: wheel, z: part.r });
        const tPart = BB_WHEEL_PARTS.traction;
        const tx = x - Math.sign(x) * (part.r + tPart.r + 0.5);
        const tw = buildDriveWheel('traction', detail, accent);
        tw.name = `robot:wheel:tank:${out.traction.length}`;
        tw.position.set(tx, sy * wheelY, tPart.r + BB_BUTTERFLY_LIFT);
        out.nodes.push(tw);
        out.traction.push({ node: tw, z: tPart.r });
        out.spin.push({ node: tw, r: tPart.r });
      }
    }
  }
  return out;
}

/** the cosmetic TOP CAP over each side plate — thickness, and how far inboard of the frame line
 *  it reaches. Deliberately narrow: it covers the outer plate and a 0.5-in lip, so the wheels are
 *  still visible from straight above through the pocket it does not cover. See `buildFrame`. */
const BB_TOP_CAP_T = 0.2;
const BB_TOP_CAP_W = BB_PLATE_T + 0.5;

/**
 * THE FRAME — side plates, cross members, belly pan, deck, tower. Two merged meshes: the
 * cosmetic one (`chassisFill`) and the structural one (the darker extrusion). Open TOP by
 * construction: the deck is inset from the frame on every side, so the mechanisms above it are
 * seen against daylight rather than against a lid.
 *
 * ── ⚠️ WHAT CARRIES THE COSMETIC COLOUR, AND WHY IT CHANGED ────────────────────────────────
 * It used to be the SIDE PLATES ALONE, which are four VERTICAL surfaces. From straight above —
 * the angle a top-down driver camera and the builder preview's orbit spend most of their time at
 * — a supporter's chosen colour presented an edge 0.22 in wide and nothing else, so it read as
 * not applied at all (owner, 2026-09-19: "chassis color change is not noticeable enough. The top
 * needs to change"). The header here CLAIMED the deck carried it; the code put the deck in the
 * structural part, and the comment on that line said so explicitly.
 *
 * ⚠️ 2026-09-21: THE DECK IS FULL-FOOTPRINT NOW (owner ruling — see the deck line below); the
 * paragraph that follows is the history of why it used to be inset.
 *
 * That line's reason was real: a full-width coloured deck plus coloured plates "turned the top of
 * the robot back into one flat slab". What answers BOTH is that the deck is INSET — it is
 * `length − 2.47` by `innerHW × 2` (12.32 in on a 17-in chassis), framed on every side by the
 * dark cross members, the dark rails and the wheel pockets. A coloured panel inside a dark frame
 * is not a slab. The TOP CAPS add the rest: a narrow cosmetic strip lying on each side plate's
 * top edge, which is the one perimeter surface no mechanism stands on, so the colour survives
 * whatever the player bolts to the deck.
 *
 * The ALLIANCE is untouched by all of it and must stay that way — it is the outline round the
 * bumper band and the two ROBOT SIGNS, which is a RULES matter (G414, R401–R403), not a style
 * one. `chassisFill`'s 7-key allowlist is what keeps a cosmetic from ever reading as an alliance.
 */
export function buildFrame(spec: RobotSpec): THREE.Object3D[] {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const innerHW = innerHalfWidth(spec);
  const outerY = hw - BB_PLATE_T / 2;
  const innerY = hw - BB_PLATE_T * 1.5 - BB_PLATE_GAP;
  const holes = Math.max(2, Math.round(spec.length / 4.5));
  // NOT KEYED ON `heightIn`: nothing in the frame depends on it any more, so two builds that
  // differ only in declared height share this buffer.
  const key = `${spec.length}|${spec.width}|${spec.drivetrain}`;

  // ⚠️ A SWERVE CHASSIS HAS NO WHEEL CHANNEL. The pods bolt UNDER a box frame at `BB_POD_INSET`
  // from each face, and a 1.5-in-wide pod wheel there runs straight through an inner side plate
  // at `innerY` — so for swerve there is one plate a side, at the frame line, and nothing behind
  // it. The footprint is unchanged either way: the OUTER plate's outer face is still the frame.
  // X-DRIVE is the same case for the same reason: a 45° omni inset by its own reach spans the
  // inner plate's line (`BB_XDRIVE_INSET_Y`).
  const dropInner = spec.drivetrain === 'swerve' || spec.drivetrain === 'xdrive';
  const plateYs = dropInner ? [outerY] : [outerY, innerY];

  const skin = framePart(`skin:${key}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    for (const sy of [1, -1] as const) {
      for (const y of plateYs) {
        const p = platePlane(spec.length, BB_PLATE_H, BB_PLATE_T, holes);
        p.translate(0, sy * y, BB_PLATE_H / 2);
        parts.push(p);
      }
      // THE TOP CAP — lying ON that side's plate, the one perimeter surface a mechanism never
      // stands on, so a top-down view always has the colour somewhere even on a robot whose deck
      // is covered end to end.
      parts.push(
        boxAt(spec.length, BB_TOP_CAP_W, BB_TOP_CAP_T, 0, sy * (hw - BB_TOP_CAP_W / 2), BB_PLATE_H + BB_TOP_CAP_T / 2),
      );
    }
    // THE DECK — the top plate mechanisms bolt to, and the biggest surface a top-down camera sees.
    // ⚠️ IT COVERS THE WHOLE CHASSIS, WHEELS INCLUDED (owner, 2026-09-21: "make the robot's chassis
    // top plate cover the wheels too (so essentially the plate covers the whole chassis)"). It was
    // INSET — `length − 2.47` by the inner channel — to avoid "one flat slab", which left the wheel
    // pockets open from above; that ruling is reversed. Every wheel and pod already lives under
    // `BB_DECK_Z − 0.26` (the pod stack is derived from it), so nothing pokes through the lid.
    parts.push(boxAt(spec.length, spec.width, 0.26, 0, 0, BB_DECK_Z - 0.13));
    return parts;
  });
  const frame = framePart(`frame:${key}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    // CROSS MEMBERS, front and rear, tying the two side assemblies together under the deck.
    // ⚠️ SET BACK BEHIND THE END PLATES AND BELOW THE DECK'S UNDERSIDE (owner, 2026-09-21: "something
    // with the back plate must be meshing because it is glitching"). They used to end flush on the
    // chassis end (outer face at ±hl) with their top at `BB_DECK_Z` — exactly the END PLATE's outer
    // face and the full-footprint DECK's top face, in a different material, which is per-pixel
    // z-fighting on both planes. One plate thickness in and one deck thickness down shares no face.
    for (const sx of [1, -1] as const) {
      parts.push(
        boxAt(BB_RAIL_T, hw * 2 - BB_PLATE_T * 2, BB_RAIL_T, sx * (hl - BB_PLATE_T - BB_RAIL_T / 2), 0, BB_DECK_Z - 0.26 - BB_RAIL_T / 2),
      );
    }
    // BELLY PAN — thin, low, spanning the inner channel
    parts.push(boxAt(spec.length - BB_RAIL_T * 2.6, innerHW * 2, 0.22, 0, 0, 0.85));
    return parts;
  });

  const skinMesh = new THREE.Mesh(skin, solidMat(chassisFill(spec.chassisColor), 0.55, 0.15));
  skinMesh.name = 'robot:frame:skin';
  const frameMesh = new THREE.Mesh(frame, solidMat(ALU_DK, 0.45, 0.4));
  frameMesh.name = 'robot:frame:rails';
  return [cast(skinMesh), cast(frameMesh)];
}

/**
 * ── END PLATES (owner, 2026-09-20: "cover up the back of the chassis with a full back plate,
 * and cover up the front with two small plates just to hide the wheels") ───────────────────────
 *
 * The frame above is two SIDE plates only — front and back are open by construction (a side
 * plate is edge-on from either end, a 0.22-in sliver), so the drivetrain and the inside of the
 * channel show straight through both ends. This closes that picture, and it is COSMETIC ONLY:
 * `chassis3dShapes(spec, h)[0]` and the 2D `bbRobotSolids(...).chassis` are already the full
 * solid `[-hl,hl] × [-hw,hw]` box at every height a plate can occupy, so anything built with its
 * outer face at ±hl sits inside solid collider already and gets none of its own — `endPlateChecks`
 * (RENDER lane, `scripts/smoke-biobuzz/render.ts`) proves the containment instead of assuming it.
 *
 * An END WITHOUT a mounted mouth (`bbMouths(spec)` has no rect there) gets one FULL plate, the
 * inner width between the two OUTER side plates' own inner faces. An END WITH a mouth gets two
 * CORNER plates instead, one per side, pinned to that side's outer-plate inner face and reaching
 * in just far enough to cover the ACTUAL wheel or swerve pod `buildWheels` puts there
 * (`endWheelSpanY`) — so the plate never claims more of the opening than the hardware needs.
 *
 * ⚠️ A CORNER PLATE RUNS FLOOR TO PLATE HEIGHT, EVEN WHERE THE WHEEL SITS INSIDE THE MOUTH'S
 * THROAT BAND (the default Sniper: `frontback`, SWERVE, pods well inboard). It stands ON THE FRAME
 * FACE, which is the BACK WALL of the intake pocket and already solid chassis collider at every
 * height (`chassis3dShapes[0]`, `bbRobotSolids().chassis`) — the open pocket an element rolls
 * through is in FRONT of that face, out to the tip line. The first cut kept the plate above
 * `BB3_MOUTH_SLOT_Z` there, which left a 1-in sliver and the wheels in plain view: the opposite
 * of what the owner asked for ("two small plates just to hide the wheels").
 */
const BB_ENDPLATE_MARGIN = 0.15;

/** the corner wheel/pod's lateral (y) placement nearest a chassis END — the SAME formulas
 * `buildWheels` places by, so a plate sized off this can never disagree with what is actually
 * drawn there. `s` is the side sign, `+1` the robot's LEFT and `−1` its RIGHT. */
export function endWheelSpanY(spec: RobotSpec, s: 1 | -1): { center: number; half: number } {
  const hw = spec.width / 2;
  // ⚠️ THE POD'S HALF-EXTENT IS `BB_POD_INSET`, NOT `BB_POD_W / 2`. The fork box is not the widest
  // thing on a pod — the slew ring's flange is, on every chassis — and `BB_POD_INSET` is already
  // "the furthest anything on this pod reaches from its centre" by construction (the max of the
  // slewing box's half-diagonal and that flange). The fork box happened to be wider than the ring
  // while the fork straddled a 48 mm mecanum; building it around the pod's OWN 72 mm Hogback
  // narrowed it to 2.12 in and left the corner plate stopping 0.19 in short of the ring it is
  // there to hide.
  if (spec.drivetrain === 'swerve') return { center: s * (hw - BB_POD_INSET), half: BB_POD_INSET };
  if (spec.drivetrain === 'xdrive') return { center: s * Math.max(0.5, hw - BB_XDRIVE_INSET_Y), half: BB_XDRIVE_REACH };
  // tank / mecanum / butterfly: a straight wheel dead in the channel between the two side
  // plates — butterfly's corner set (the mecanum roller) rides the same axle line as its inboard
  // traction twin, so one formula covers all three.
  return { center: s * (hw - BB_PLATE_T - BB_PLATE_GAP / 2), half: BB_WHEEL_W / 2 };
}

const ENDPLATE_GEO_CACHE = new Map<string, THREE.BoxGeometry>();
function endPlateGeo(sx: number, sy: number, sz: number): THREE.BoxGeometry {
  const key = `${sx}|${sy}|${sz}`;
  let g = ENDPLATE_GEO_CACHE.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(sx, sy, sz);
    ENDPLATE_GEO_CACHE.set(key, g);
    SHARED_GEO.add(g);
  }
  return g;
}

/** ONE end's plate(s) — see the header above. `mouthHalf` is `bbMouths(spec)`'s own half-width
 * on this edge (`undefined` when the edge carries no mouth at all). */
function buildEndPlate(spec: RobotSpec, end: 'front' | 'back', mouthHalf: number | undefined): THREE.Mesh[] {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const sign = end === 'front' ? 1 : -1;
  const mat = solidMat(chassisFill(spec.chassisColor), 0.55, 0.15);
  const cx = sign * (hl - BB_PLATE_T / 2); // outer face flush with ±hl — never past it

  if (mouthHalf === undefined) {
    const mesh = cast(new THREE.Mesh(endPlateGeo(BB_PLATE_T, (hw - BB_PLATE_T) * 2, BB_PLATE_H), mat));
    mesh.position.set(cx, 0, BB_PLATE_H / 2);
    return [mesh];
  }

  const out: THREE.Mesh[] = [];
  for (const s of [1, -1] as const) {
    const { center, half } = endWheelSpanY(spec, s);
    const outerFace = s * (hw - BB_PLATE_T); // the outer side plate's own inner face, this side
    const innerMag = Math.max(0, Math.abs(center) - half - BB_ENDPLATE_MARGIN);
    const width = Math.max(0.1, Math.abs(outerFace) - innerMag);
    const cy = (s * (Math.abs(outerFace) + innerMag)) / 2;
    const z0 = 0; // floor to plate height — see the header: the frame face is solid already
    const h = BB_PLATE_H - z0;
    const mesh = cast(new THREE.Mesh(endPlateGeo(BB_PLATE_T, width, h), mat));
    mesh.position.set(cx, cy, z0 + h / 2);
    out.push(mesh);
  }
  return out;
}

/** ALL of a robot's end plates, named for `id` so `endPlateChecks` (RENDER lane) and the live
 * per-robot group agree on what to look for: `robot:<id>:endplate:back` for a full plate,
 * `robot:<id>:endplate:front:l` / `:r` for a corner pair. */
export function buildEndPlates(spec: RobotSpec, id: number): THREE.Object3D[] {
  const mouths = bbMouths(spec);
  const frontHalf = mouths.find((m) => m.edge === 'front')?.y1;
  const backHalf = mouths.find((m) => m.edge === 'back')?.y1;
  const out: THREE.Object3D[] = [];
  for (const [end, half] of [['front', frontHalf], ['back', backHalf]] as const) {
    const parts = buildEndPlate(spec, end, half);
    if (parts.length === 1) {
      parts[0].name = `robot:${id}:endplate:${end}`;
    } else {
      parts[0].name = `robot:${id}:endplate:${end}:l`;
      parts[1].name = `robot:${id}:endplate:${end}:r`;
    }
    out.push(...parts);
  }
  return out;
}

/**
 * ── THE ROBOT SIGN (§12.4, R401 / R402 / R403) ──────────────────────────────────────────────
 *
 * ⚠️ THIS IS A RULED ASSEMBLY, NOT A DECORATION, AND EVERY NUMBER BELOW IS THE MANUAL'S.
 * Competition Manual V1 §12.4 p127: "A ROBOT SIGN is a required assembly which attaches to the
 * ROBOT. A ROBOT SIGN simultaneously identifies a ROBOT'S team number as well as its ALLIANCE
 * affiliation for FIELD STAFF." Three rules bind what is drawn:
 *
 *  - **R401 (p127) — MINIMUM OF TWO PER ROBOT**, "in at least 2 separate locations … on opposite
 *    or adjacent surfaces of the ROBOT, 90 degrees apart", minimally 6.5 in wide and 2.5 in tall,
 *    supported by the robot's structure. Intent: readable by FIELD STAFF from 12 ft away. This
 *    file drew ONE, on the left side plate only — owner, 2026-09-19: "the number plates should be
 *    on both sides of the robot". Both side plates is the OPPOSITE-surfaces case.
 *  - **R402 (p128) — the ALLIANCE rectangle** is "a solid red or blue opaque background at least
 *    6.5 in. by 2.5 in.", and "visible markings on ROBOT SIGNS when installed on the ROBOT, other
 *    than the following, are prohibited" — the R403 team number, fasteners, narrow colour slivers
 *    at corners/folds/cutouts, and narrow template marks. ⚠️ **THAT IS WHY THERE IS NO LONGER A
 *    WHITE BORDER.** The old panel stroked a 6-px white frame round itself, which is none of the
 *    four and is therefore a prohibited marking. The colour is the MATCH SCHEDULE's alliance,
 *    which is the `alliance` argument, never anything off the spec.
 *  - **R403 (pp128–129) — the team number**: "solid opaque white Arabic numbers … approximately
 *    2.25 in. (5.70 cm) tall", with "a minimum of approximately 0.25 in. (0.60 cm) of background
 *    surrounding the numbers", and they "may not be vertically stacked" (Fig 12-10, which also
 *    rules mirrored text NOT OK). One line, upright, un-mirrored, white on the alliance fill.
 *
 * The plate is therefore **6.5 × 2.75 in**: 6.5 is R401.B/R402 exactly, and 2.75 is the only
 * height at which R403.A's 2.25-in digits and R403.B's 0.25-in margin both hold (2.25 + 2×0.25),
 * which is ≥ R401.C's 2.5 minimum. It does NOT scale with the chassis — the rule is an absolute
 * size in inches, and the old `min(3.6, length × 0.3)` square was under the legal minimum on
 * every build in the game. The smallest legal BIOBUZZ chassis is 11 × 10 in (`lengthLimits` /
 * `widthLimits`), so a 6.5-in sign fits on any side plate this builder can make.
 */
export const BB_SIGN_W = 6.5;
/** R403.A — cap height of the numerals. */
export const BB_SIGN_DIGIT_H = 2.25;
/** R403.B — background clear of the numerals, on every side. */
export const BB_SIGN_MARGIN = 0.25;
export const BB_SIGN_H = BB_SIGN_DIGIT_H + BB_SIGN_MARGIN * 2;
/** R401.B/R402 — the width floor. R401.C/R402 — the height floor. Exported so the RENDER lane
 *  checks the plate against the RULE rather than against a literal copied out of this file. */
export const BB_SIGN_MIN_W = 6.5;
export const BB_SIGN_MIN_H = 2.5;

/**
 * What R403 puts on the plate for a given spec. `teamNumber` 0 is "no team declared" — the 2D
 * team card renders `-` there (`GameView.tsx`, `HomeMenu.tsx`) and this matches that intent
 * rather than printing a literal `0`, which would read as a real team number.
 *
 * DOM-free and exported so the RENDER lane can check the string without a canvas.
 */
export function bbRobotSignText(spec: Pick<RobotSpec, 'teamNumber'>): string {
  const n = Math.round(spec.teamNumber);
  return Number.isFinite(n) && n > 0 ? String(n) : '-';
}

/** px per inch the sign canvas is rasterized at — 2.25-in digits land at 108 px. */
const SIGN_PX_PER_IN = 48;

/**
 * The plate's artwork, cached by (text, alliance): TWO signs on one robot are the SAME texture,
 * and a robot's team number and alliance do not change inside a `bbSpecKey` rebuild.
 *
 * ⚠️ IT IS NOT PRE-MIRRORED ANY MORE. The old comment here claimed no proper rotation could get
 * the outward normal, a vertical "up" AND un-mirrored text at once, so the canvas was drawn
 * flipped to cancel a flip. That is false — it is true of `Euler` triples, not of rotations:
 * `makeBasis(up × n, up, n)` is right-handed by construction for either side plate (see
 * `bbRobotSignOrientation`). Fig 12-10 rules mirrored text NOT OK, so one un-mirrored canvas
 * serving both signs is both the legal answer and the cheap one.
 */
const SIGN_TEXTURE_CACHE = new Map<string, THREE.CanvasTexture>();
function getSignTexture(text: string, alliance: 'red' | 'blue'): THREE.CanvasTexture {
  const key = `${text}|${alliance}`;
  const cached = SIGN_TEXTURE_CACHE.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(BB_SIGN_W * SIGN_PX_PER_IN);
  canvas.height = Math.round(BB_SIGN_H * SIGN_PX_PER_IN);
  const ctx = canvas.getContext('2d')!;
  // R402 — the whole plate is the solid, opaque alliance rectangle, and nothing else is on it.
  ctx.fillStyle = alliance === 'blue' ? BLUE : RED;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // R403.A — solid opaque WHITE Arabic numerals at a 2.25-in cap height, on ONE line (R403.C
  // forbids stacking them). `system-ui` reports a cap height near 0.72 em, so the em size that
  // puts the caps at 2.25 in is 2.25 / 0.72.
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round((BB_SIGN_DIGIT_H / 0.72) * SIGN_PX_PER_IN)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // R403.B — the numerals stay inside the 0.25-in background margin. A five-digit team number is
  // wider than 6.0 in at natural proportions, so it is CONDENSED rather than allowed to run into
  // the margin: R403 fixes the height and the margin and specifies no font or width.
  const inner = (BB_SIGN_W - BB_SIGN_MARGIN * 2) * SIGN_PX_PER_IN;
  const natural = ctx.measureText(text).width;
  const squeeze = natural > inner ? inner / natural : 1;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(squeeze, 1);
  ctx.fillText(text, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  SIGN_TEXTURE_CACHE.set(key, tex);
  return tex;
}

/**
 * THE DECAL TEXTURE — the `getSignTexture` technique, cached per `decal|accent|aspect`. Painted
 * TRANSPARENT everywhere but the shape itself, so the deck's own `chassisFill` shows through the
 * rest of the box the decal mesh sits on. `aspect` is the deck's own length÷width, so the same
 * five shapes drawn in 2D (`render/drawRobot.ts`'s `drawDecal`) land in the same PARAMETRIC
 * fractions of the footprint here — a decal must scale to any legal chassis, never absolute
 * inches (`docs/cosmetics-plan.md` §4's stated risk). The canvas's U axis is a `BoxGeometry`
 * top face's own U, which runs along local +x — the chassis' forward axis — so `chevron`'s point
 * at high U is genuinely forward-pointing.
 */
const DECAL_TEX_CACHE = new Map<string, THREE.CanvasTexture>();
function getDecalTexture(decal: string, accent: string, aspect: number): THREE.CanvasTexture {
  const key = `${decal}|${accent}|${aspect.toFixed(3)}`;
  const cached = DECAL_TEX_CACHE.get(key);
  if (cached) return cached;
  const w = 256;
  const h = Math.max(1, Math.round(w / Math.max(0.05, aspect)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = accent;
  const hw = w / 2;
  const hh = h / 2;
  switch (decal) {
    case 'stripe': {
      const sw = h * 0.18;
      ctx.fillRect(0, hh - sw / 2, w, sw);
      break;
    }
    case 'racing': {
      const sw = h * 0.1;
      const off = h * 0.15;
      ctx.fillRect(0, hh - off - sw / 2, w, sw);
      ctx.fillRect(0, hh + off - sw / 2, w, sw);
      break;
    }
    case 'chevron': {
      const d = w * 0.22;
      const notch = d * 0.55;
      const half = hh * 0.82;
      ctx.beginPath();
      ctx.moveTo(hw + d * 0.5, hh);
      ctx.lineTo(hw - d * 0.5, hh - half);
      ctx.lineTo(hw - d * 0.5 + notch, hh - half);
      ctx.lineTo(hw + d * 0.5 + notch, hh);
      ctx.lineTo(hw - d * 0.5 + notch, hh + half);
      ctx.lineTo(hw - d * 0.5, hh + half);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'hazard': {
      // rear third — LOW U, since the chassis' rear is local −x, i.e. canvas U → 0
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w / 3, h);
      ctx.clip();
      const bw = h * 0.16;
      for (let o = -h; o < w / 3 + h; o += bw * 2) {
        ctx.beginPath();
        ctx.moveTo(o, 0);
        ctx.lineTo(o + bw, 0);
        ctx.lineTo(o + bw + h, h);
        ctx.lineTo(o + h, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 'checker': {
      const cols = 4;
      const cw = w / cols;
      const bandH = h * 0.3;
      const rows = Math.max(1, Math.round(bandH / cw));
      const rh = bandH / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if ((i + j) % 2 === 0) ctx.fillRect(i * cw, hh - bandH / 2 + j * rh, cw, rh);
        }
      }
      break;
    }
    case 'star': {
      // Same call as 2D `drawDecal`'s `star` case (`render/drawRobot.ts`), not a
      // re-derivation: `starPoints` needs one radius meaning the same physical distance on
      // both axes, and it gets one here too because this canvas's per-pixel scale is already
      // isotropic — `h` above is `w / aspect`, chosen so canvas px map to the same inches in
      // U and V — so `Math.min(hw, hh)`, the canvas's own half-extents, IS that shared
      // physical half-dimension, with no `aspect` division needed a second time. 0.8x
      // matches the 2D case exactly, so both renderers draw the identical shape at the
      // identical size.
      const r = Math.min(hw, hh) * 0.8;
      const pts = starPoints(hw, hh, r, 0); // angle 0 ⇒ +x from centre, i.e. forward (high U)
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  DECAL_TEX_CACHE.set(key, tex);
  return tex;
}

/** silver frame colour for the `rounded` plate style. */
const PLATE_SILVER = '#c7ced6';

/**
 * THE SIGN PLATE FRAME — a border round the sign placard (`docs/cosmetics-plan.md` §3.4), built
 * as GEOMETRY (a `Shape` with a hole, the same technique `platePlane` uses), not a texture: a
 * frame is a real border, not artwork, and this keeps it DOM-free. `'bold'` is a thick frame in
 * the accent colour; `'rounded'` a thin rounded frame in silver — the placard's own fill/number
 * are untouched, this sits a hair further out (see the call site).
 */
const SIGN_PLATE_GEO_CACHE = new Map<string, THREE.ExtrudeGeometry>();
function buildSignPlateGeometry(plate: string): THREE.ExtrudeGeometry {
  const hit = SIGN_PLATE_GEO_CACHE.get(plate);
  if (hit) return hit;
  const thick = plate === 'bold' ? 0.35 : 0.18;
  const r = plate === 'rounded' ? 0.4 : 0;
  const ow = BB_SIGN_W + thick * 2;
  const oh = BB_SIGN_H + thick * 2;
  const ohw = ow / 2;
  const ohh = oh / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-ohw + r, -ohh);
  shape.lineTo(ohw - r, -ohh);
  if (r) shape.quadraticCurveTo(ohw, -ohh, ohw, -ohh + r);
  shape.lineTo(ohw, ohh - r);
  if (r) shape.quadraticCurveTo(ohw, ohh, ohw - r, ohh);
  shape.lineTo(-ohw + r, ohh);
  if (r) shape.quadraticCurveTo(-ohw, ohh, -ohw, ohh - r);
  shape.lineTo(-ohw, -ohh + r);
  if (r) shape.quadraticCurveTo(-ohw, -ohh, -ohw + r, -ohh);
  const hole = new THREE.Path();
  const ihw = BB_SIGN_W / 2;
  const ihh = BB_SIGN_H / 2;
  hole.moveTo(-ihw, -ihh);
  hole.lineTo(ihw, -ihh);
  hole.lineTo(ihw, ihh);
  hole.lineTo(-ihw, ihh);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false, curveSegments: 8 });
  SIGN_PLATE_GEO_CACHE.set(plate, geo);
  SHARED_GEO.add(geo);
  return geo;
}

/**
 * The orientation of the sign on the side plate whose outward normal is `+y * side`.
 *
 * Built as an explicit BASIS rather than an `Euler`: a plane's texture "right" is its +x, so the
 * only basis that reads un-mirrored from outside is `x = y × n` with `n` the outward normal and
 * `y` vertical — right-handed by construction (det +1) on both sides, which an Euler triple
 * cannot express without flipping one axis. Fig 12-10: mirrored text is NOT OK.
 *
 * Exported for the RENDER lane, which checks the BASIS (outward, upright, determinant +1) rather
 * than a rotation triple — a mirrored sign is a rule violation the old spelling made invisible.
 */
export function bbRobotSignOrientation(side: 1 | -1): THREE.Quaternion {
  const n = new THREE.Vector3(0, side, 0);
  const up = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, n);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
}

// ⚠️ THE GROUP'S REBUILD KEY IS `bbSpecKey` (`../specKey.ts`), NOT A COPY OF IT HERE. This
// file used to carry its own `specKey`, and the saved-robot THUMBNAIL cache in the main chunk
// needs the same answer without loading this chunk at all — two copies is the exact way a
// thumbnail ends up showing the previous build. (The local copy also left `drivetrain` out, so
// swapping mecanum for tank never rebuilt the wheels.)

/**
 * THE INTAKE ROLLER — A RIGID HUB THAT CLEARS THE SLOT, AND COMPLIANT FLAPS THAT REACH INTO IT.
 *
 * ⚠️ IT USED TO BE A 1-IN BARREL AT z 1.15, i.e. a rigid cylinder whose bottom sat 0.15 in off
 * the floor. A POLLEN is 2.8 in across and a NECTAR 3.6, so the drawn roller passed clean THROUGH
 * every element in the mouth — and `chassis3dShapes` leaves the pocket open from the floor to
 * `BB3_MOUTH_SLOT_Z` (= one NECTAR diameter) with no roller collider at all, so the PICTURE was
 * blocking a gap the PHYSICS says is clear, by 3.45 in. Owner, 2026-09-19: "the intake roller
 * seems way too low for it to intake pollen and nectar realistically", and "it should still allow
 * for pollen and nectar to pass under".
 *
 * Those two asks — GRIP it, and let it PASS UNDER — cannot both hold for a rigid part: gripping a
 * POLLEN needs the bottom below 2.8 and clearing a NECTAR needs it at 3.6 or more. They hold for
 * a real over-the-bumper intake because its low part is the COMPLIANT part, which is exactly
 * "grip when driven, yield when not". So the hub clears the slot and the flaps reach down into
 * it.
 *
 * ⚠️ `BB_ROLLER_Z` IS DERIVED FROM THE COLLIDER, NOT TYPED. If the mouth slot ever moves, the
 * picture follows it instead of drifting — which is the whole failure this replaces.
 */
/** how far inboard of the frame line an intake side arm is set — the outer plate's own thickness
 *  plus a clearance, so the arm bolts to that plate's inner face instead of sharing its outer
 *  one. Exported for the RENDER lane, which checks it against the measured coplanarity hazard. */
export const BB_INTAKE_ARM_INSET = BB_PLATE_T + 0.06;

const BB_ROLLER_HUB_R = 0.75;
/** the compliant flaps' tip radius — a 4-in wheel. They reach 0.30 in below a POLLEN's crown and
 *  1.10 below a NECTAR's; that overlap IS the compression that makes the roller grip. */
const BB_ROLLER_FLAP_R = 2.0;
/** hub bottom `BB3_MOUTH_SLOT_Z + 0.15`, i.e. a bolt's clearance above the open pocket. */
const BB_ROLLER_Z = BB3_MOUTH_SLOT_Z + BB_ROLLER_HUB_R + 0.15;
/** how many compliant flaps go round the hub. */
const BB_ROLLER_FLAPS = 3;
/** the flaps' thickness (in) — half of it is what the deflection law has to clear the slot by. */
const BB_ROLLER_FLAP_T = 0.14;
/** where a flap tip has to be held to leave the collider's pocket genuinely open (in). */
const BB_ROLLER_PASS_Z = BB3_MOUTH_SLOT_Z + BB_ROLLER_FLAP_T / 2;

/**
 * HOW FAR A FLAP IS FOLDED BACK at hub angle `a` (rad, 0 = +x, CCW in the mouth's x–z plane).
 *
 * ⚠️ THIS IS WHAT MAKES "PASS UNDER" TRUE IN THE PICTURE, AND IT RUNS WHETHER OR NOT THE ROLLER
 * IS SPINNING (owner, 2026-09-19: an element must still be able to pass under the roller).
 * `chassis3dShapes` leaves the mouth's pocket open from the tiles to `BB3_MOUTH_SLOT_Z` and the
 * roller is not a collider in either backend — so the only thing that could ever block that
 * pocket is the DRAWING, and a rigid flap sweeping to `BB_ROLLER_FLAP_R` blocks it by 1.1 in.
 *
 * A flap is hinged at the hub rim, so its tip sits at `hypot`-by-cosine-rule radius
 * `√(hub² + L² + 2·hub·L·cos d)`. Solve that for the radius the slot allows and you get the
 * fold: none at all over the top of the sweep, total at bottom dead centre. That IS compliance —
 * "grip when driven, yield when not" — rather than an animation laid over a rigid part.
 */
function flapFold(a: number): number {
  const L = BB_ROLLER_FLAP_R - BB_ROLLER_HUB_R;
  // how far BELOW the roller's own axis a flap tip may reach (negative)
  const target = BB_ROLLER_PASS_Z - BB_ROLLER_Z;
  const sa = Math.sin(a);
  // the tip sits at `hub·sin a + L·sin(a − fold)`, so this is the sine the folded flap needs
  const s = (target - BB_ROLLER_HUB_R * sa) / L;
  if (sa >= s) return 0; // unfolded already clears it — no load, no yield
  // `sin φ ≥ s` holds on [asin s, π − asin s], and `s` is always negative here (the hinge alone
  // can never be `target` low), so the nearest edge going BACKWARD is the upper one
  const phi = Math.PI - Math.asin(Math.max(-1, Math.min(1, s)));
  const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.max(0, norm - phi);
}

/** ONE drawn roller: the hub that spins, and the flaps that are posed from the phase. */
interface BbRoller {
  hub: THREE.Object3D;
  flaps: THREE.Object3D[];
  phase: number;
}

/** ONE side-roller wheel (`siderollers`): a plain compliant-wheel cylinder that just spins about
 *  its own (vertical) axis — no flap fold, unlike the sweeper. `sign` is which way it turns, so
 *  the pair draws a POLLEN in rather than fighting each other. */
interface BbSideRoller {
  mesh: THREE.Object3D;
  sign: 1 | -1;
  phase: number;
}

/**
 * the `siderollers` wheel: a moulded HUB with a LUGGED compliant tread round it, standing on its
 * own vertical axis, built in the wheel's own local frame (z is the spin axis) so the group that
 * carries it can simply take `rotation.z`. Two geometries because they are two materials — the
 * hub is aluminium and the tread takes the cosmetic accent, the same split the sweeper's own
 * barrel and flaps make. Nothing here is spec-dependent, so both are module-level singletons.
 *
 * ⚠️ **THE DRAWN TREAD'S EXTENT IS EXACTLY THE COLLIDER'S `BB_SIDE_ROLLER_R` CYLINDER, AND THAT
 * IS WHAT THE 15° LUG OFFSET IS FOR.** Each lug is one facet of the same 12-gon the solid is: its
 * outer face is the chord at `R·cos(15°)` and its corners land on `hypot(R·cos15, R·sin15) = R`.
 * Centre the first lug on 0° and those corners fall at 15°, 45°, … — never on the mouth's own
 * outward axis — and the drawn wheel would measure 1.449 where the sim credits 1.5. Centring them
 * on 15° + k·30° puts corners at 0°, 90°, 180° and 270°, so the RENDER lane's "the drawn part
 * that reaches is the part the sim credits" holds to the last decimal. The lugs ALTERNATE in
 * height — six full, six slightly recessed — which reads as a moulded tread rather than a smooth
 * puck without anything standing proud of the solid's own z band. 0.55 of the height was tried
 * first and reads as a STAR, not a wheel.
 */
const SIDE_ROLLER_LUGS = 12;
let sideRollerHubGeo: THREE.BufferGeometry | null = null;
let sideRollerTreadGeo: THREE.BufferGeometry | null = null;
function sideRollerHubGeometry(): THREE.BufferGeometry {
  if (!sideRollerHubGeo) {
    // a hair under the tread's full height, so the metal centre reads as recessed from above
    const g = new THREE.CylinderGeometry(BB_SIDE_ROLLER_HUB_R, BB_SIDE_ROLLER_HUB_R, BB_SIDE_ROLLER_H * 0.86, 12);
    g.rotateX(Math.PI / 2);
    SHARED_GEO.add(g);
    sideRollerHubGeo = g;
  }
  return sideRollerHubGeo;
}
function sideRollerTreadGeometry(): THREE.BufferGeometry {
  if (!sideRollerTreadGeo) {
    const half = Math.PI / SIDE_ROLLER_LUGS; // 15°
    const faceR = BB_SIDE_ROLLER_R * Math.cos(half);
    const lugW = 2 * BB_SIDE_ROLLER_R * Math.sin(half);
    // the lug runs from just inside the hub out to the chord, so there is no seam at the root
    const inner = BB_SIDE_ROLLER_HUB_R - 0.05;
    const lugLen = faceR - inner;
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < SIDE_ROLLER_LUGS; k++) {
      const tall = k % 2 === 0; // the EVEN lugs own the 0°/90°/180°/270° corners — see the header
      const h = tall ? BB_SIDE_ROLLER_H : BB_SIDE_ROLLER_H * 0.78;
      parts.push(new THREE.BoxGeometry(lugLen, lugW, h).translate(inner + lugLen / 2, 0, 0).rotateZ(half + (k * 2 * half)));
    }
    const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false) ?? parts[0];
    for (const p of parts) if (p !== merged) p.dispose();
    SHARED_GEO.add(merged);
    sideRollerTreadGeo = merged;
  }
  return sideRollerTreadGeo;
}

// ── RAMP DIMENSIONS THAT ARE THE PICTURE'S, NOT THE SIM'S — the rail section (the crossbar is now
// the WEDGE, drawn from `config.ts`'s own leading-edge/crest/drop points and `BB_RAMP_WEDGE_THICK`
// — there is nothing left for this file to size on its own for it). The reach itself (`BB_RAMP_L`,
// `_PIVOT_BACK`, `_PIVOT_Z`, `_ANGLE`) is `config.ts`'s; these two only say how thick the rails
// that carry it are drawn.
const BB_RAMP_RAIL_X = 0.5;
const BB_RAMP_RAIL_Y = 0.25;
/** the pivot's DEPLOYED rotation about the mouth's own y-axis (rad): level (π/2 off the
 *  folded-vertical rest, built along local +z) plus the deployed tilt below it. FOLDED is
 *  rotation 0 — see the header on `buildIntake`'s `ramp` branch for the derivation. */
const BB_RAMP_DEPLOYED_ROT = Math.PI / 2 + BB_RAMP_ANGLE;

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

/** an angle folded into (−π, π]. Any bearing DIFFERENCE that is going to be slewed has to go
 *  through this first, or a target 1° the other side of the wrap slews the long way round. */
function wrapPi(a: number): number {
  return ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/** `d`, limited to ±`max` — the one step of a rate limiter, in whatever unit `d` is in. */
function clampAbs(d: number, max: number): number {
  return d > max ? max : d < -max ? -max : d;
}

/**
 * THE OVER-THE-BUMPER INTAKE (owner playtest #14), one assembly per mounted edge.
 *
 * ⚠️ THE REACH IS `bbMouths`, NEVER A LITERAL. The mouth rects are the sim's own capture areas
 * and `footprintExtents` grows the collider by the same `INTAKE_PRESETS[…].reach`, so reading
 * them here is what makes "the drawn intake is the grab area" true in 3D the way `drawRobot.ts`
 * already makes it true in 2D. It is also what makes this lane survive the intake sim changing
 * underneath it: lengthen the reach constant and the model gets longer for free.
 *
 * Built in the MOUTH's own frame (`bbMouthFrame`: origin at the mouth's inner edge, +x OUTWARD,
 * +y along the edge) for the same reason the sprite is — one orientation, no sign-juggling, and
 * no chance of a flank intake being drawn where a front one acts. `rail` is where the frame
 * line falls in that frame, so everything outboard of it is genuinely outside the robot.
 */
/* EXPORTED for the RENDER lane, which measures the drawn plate tips and the front brace against
 * `bbMouths` on the real group. It cannot go through `buildRobotGroup`: the wheel roller stripe
 * is a canvas texture and the lane has no DOM. */
export function buildIntake(
  spec: RobotSpec,
  /** the cosmetic accent (`accentFill`). Defaults to `SWEEPER` — a no-op tint — so every
   * existing caller, this lane's own included, is unchanged. */
  accent: string = SWEEPER,
): { nodes: THREE.Object3D[]; rollers: BbRoller[]; sideRollers: BbSideRoller[]; rampPivots: THREE.Group[] } {
  const rollerMat = solidMat(tint3d(SWEEPER, accent, 0.5), 0.5, 0.25);
  const nodes: THREE.Object3D[] = [];
  const rollers: BbRoller[] = [];
  const sideRollers: BbSideRoller[] = [];
  const rampPivots: THREE.Group[] = [];
  // one archetype for the whole robot (`bbIntakeKindOf`), never per mouth — every mounted edge
  // carries the same hardware. Byte-identical for `sweeper`: nothing below reads `kind` on that
  // path except to skip the two blocks that draw the other archetypes' extra parts.
  const kind = bbIntakeKindOf(spec);
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  for (const m of bbMouths(spec)) {
    const f = bbMouthFrame(m, hl, hw);
    const g = new THREE.Group();
    g.name = `robot:intake:${m.edge}`;
    g.position.set(f.ox, f.oy, 0);
    g.rotation.z = f.rot;

    const tip = f.depth; // the mouth's outer edge = the collision footprint of this edge
    const armX0 = f.rail - 1.1; // the arms start INSIDE the frame, where they are bolted
    const armLen = tip - armX0;
    // the axle stands back by the FLAP radius, not the hub's: it is the compliant tips that
    // sweep the collision extent, which is what reaches an element sitting against the mouth.
    const outer = tip - BB_ROLLER_FLAP_R;
    const inner = f.rail - 0.2; // the transfer roller, at the frame line
    const deep = outer - inner > 1.8;

    // ── TWO SIDE ARMS, AS AN OPEN TRUSS ───────────────────────────────────────────────────
    // ⚠️ NOT A SOLID PLATE (owner, 2026-09-19: the intake's sides must not be solid aluminium).
    // Each arm was a `platePlane(armLen, 2.8, 0.3, 2)` — a 4.1 × 2.8 in wall standing in front of
    // the mechanism, 3D only, while the 2D sprite has always drawn open rails. It is three
    // members now (bottom rail, axle boss, diagonal) and NO member is thicker than
    // `INTAKE_RAIL_T`, which is what the COLLIDER claims for a flank rail: the drawn arm must
    // never claim more solid than the physics has.
    const armT = INTAKE_RAIL_T;
    const railZ = BB3_MOUTH_SLOT_Z + 0.25; // the rail's own centre — its underside IS the pocket
    const bossTop = BB_ROLLER_Z + 0.6;
    const armGeo = framePart(`arm:${armLen.toFixed(2)}|${(outer - armX0).toFixed(2)}`, () => {
      const parts: THREE.BufferGeometry[] = [];
      // (1) THE BOTTOM RAIL, its underside flush with the collider's open pocket
      parts.push(boxAt(armLen, armT, 0.5, armX0 + armLen / 2, 0, railZ));
      /**
       * (1b) THE ROUNDED NOSE. ⚠️ The rail used to end on a SQUARE corner at the tip line, 1.25
       * in forward of the roller hub's own front face — which is the thing the owner was
       * looking at: *"The intake plates stick out further than the intake rollers so the
       * hitboxes are weird."* The plate still ends exactly on `tip` (the reach is the sim's and
       * nothing here may move it), but it ends on an ARC swept about the tip line's own centre
       * height instead of on a knife corner, so it reads as a plate wrapping the roller rather
       * than as a prong sticking past it. Radius is half the rail's depth, so the nose cannot
       * dip below the rail's underside and cannot close the pocket an element passes through.
       */
      const nose = new THREE.CylinderGeometry(0.25, 0.25, armT, 12);
      nose.translate(tip - 0.25, 0, railZ);
      parts.push(nose);
      // (2) THE AXLE BOSS, where the roller shaft is carried
      const boss = new THREE.CylinderGeometry(0.55, 0.55, armT, 12);
      boss.translate(outer, 0, BB_ROLLER_Z);
      parts.push(boss);
      parts.push(boxAt(0.45, armT, bossTop - railZ, outer, 0, (bossTop + railZ) / 2));
      // (3) THE DIAGONAL, from the rail's outer end back up to where the arm is bolted on
      const dx = armX0 - (armX0 + armLen);
      const dz = bossTop - railZ;
      const diag = new THREE.BoxGeometry(Math.hypot(dx, dz), armT, 0.34);
      diag.rotateY(-Math.atan2(dz, dx));
      diag.translate(armX0 + armLen / 2, 0, (railZ + bossTop) / 2);
      parts.push(diag);
      return parts;
    });
    // ⚠️ **THE ARM IS SET INBOARD OF THE FRAME LINE, AND THAT IS NOT A STYLE CHOICE** (owner,
    // 2026-09-19: "the intake side plate is meshing with chassis"). `bbMouths` makes the mouth
    // EXACTLY as wide as the chassis — measured across all three intake presets and all four
    // mounts, `f.half` equals the chassis half-width/half-length to 0.0000 in, every time — so an
    // arm at `f.half − armT/2` puts its outer face precisely ON the side plate's outer face. And
    // `armX0 = f.rail − 1.1` runs the arm 1.1 in back INSIDE the frame, by design ("where they are
    // bolted"). Two solids overlapping for 1.1 in with co-planar outer faces is per-pixel
    // z-fighting along that whole seam — the same failure the alliance line round the bumper band
    // is scaled out by a whisker to avoid, at a far bigger scale.
    //
    // `BB_PLATE_T` is the outer plate's thickness, so this lands the arm's outer face against
    // that plate's INNER face, plus a clearance: which is where a real over-the-bumper intake's
    // arm bolts anyway. The arm's own visible reach is unchanged outboard of the frame — it loses
    // 0.28 in a side on a mouth that is 17 in wide.
    for (const s of [1, -1] as const) {
      const arm = new THREE.Mesh(armGeo, solidMat(ALU, 0.45, 0.35));
      arm.position.set(0, s * (f.half - BB_INTAKE_ARM_INSET - armT / 2), 0);
      g.add(cast(arm));
    }

    /**
     * ⚠️ **THE FRONT BRACE — THE PART THE OWNER ASKED FOR, AND THE DRAWN TWIN OF THE LINTEL.**
     * Owner, 2026-09-19: *"add a bracing across the two intake plates in the front to make the
     * whole thing just have a rectangular hitbox"*, and then *"let's do a bracing in the front
     * then, to make the collision hitbox a long rectangle across in the front"*.
     *
     * A straight bar the FULL mouth width, its outer face flush on the tip line, tying the two
     * plates: what the picture had instead was two free-ended prongs with open air between them,
     * which is exactly what the collider had too (`chassis3dPocketShapes`, `sim3d/bodies.ts`,
     * closes the solve's half of it). The two halves are built from the same three numbers —
     * `bbMouths` for the width, `f.depth` for the tip, `BB3_MOUTH_SLOT_Z` for the underside —
     * so the drawn brace and the lintel cannot drift apart.
     *
     * ⚠️ **ITS UNDERSIDE IS THE SLOT, NOT A CHOSEN HEIGHT.** `BB3_MOUTH_SLOT_Z` is one NECTAR
     * diameter (3.6 in), the tallest element there is, so a POLLEN or a NECTAR still passes
     * under it and into the mouth — the same clearance the roller's flaps yield to keep, and the
     * same plane the collider's lintel starts on. Drop it and the picture blocks a gap the
     * physics says is open, which is the bug the compliant flaps were written to fix.
     */
    const braceT = 0.55;
    const braceGeo = framePart(`intakeBrace:${f.half.toFixed(2)}|${braceT.toFixed(2)}`, () => [
      boxAt(braceT, f.half * 2 - 2 * BB_INTAKE_ARM_INSET, braceT, tip - braceT / 2, 0, BB3_MOUTH_SLOT_Z + braceT / 2),
    ]);
    const brace = new THREE.Mesh(braceGeo, solidMat(ALU, 0.45, 0.35));
    brace.name = `robot:intake:brace:${m.edge}`;
    g.add(cast(brace));

    // the `ramp`'s own rails sit inboard of the arms (`railY` below); its barrel is shortened to
    // pass between them with the stated clearance. Every other kind keeps the full-width barrel
    // that shipped before archetypes existed.
    let barrel = f.half * 2 - 0.9;
    let railY = 0;
    if (kind === 'ramp') {
      railY = f.half - BB_INTAKE_ARM_INSET - armT - 0.15;
      barrel = Math.min(barrel, 2 * (railY - 0.25));
    }
    const hubGeo = framePart(`rollerHub:${barrel.toFixed(2)}`, () => [
      new THREE.CylinderGeometry(BB_ROLLER_HUB_R, BB_ROLLER_HUB_R, barrel, 12),
    ]);
    // the flap blade runs from the HINGE at the hub rim outward, so it is built with its inner
    // end at its own origin: the flap group carries the hinge, and `flapFold` the yield
    const flapGeo = framePart(`rollerFlap:${barrel.toFixed(2)}`, () => [
      boxAt(
        BB_ROLLER_FLAP_R - BB_ROLLER_HUB_R,
        barrel,
        BB_ROLLER_FLAP_T,
        (BB_ROLLER_FLAP_R - BB_ROLLER_HUB_R) / 2,
        0,
        0,
      ),
    ]);
    const roll = new THREE.Group();
    roll.name = `robot:sweeper:${m.edge}`;
    roll.position.set(outer, 0, BB_ROLLER_Z);
    const hubMesh = cast(new THREE.Mesh(hubGeo, rollerMat));
    roll.add(hubMesh);
    const flaps: THREE.Object3D[] = [];
    for (let i = 0; i < BB_ROLLER_FLAPS; i++) {
      const flap = new THREE.Group();
      flap.add(cast(new THREE.Mesh(flapGeo, rollerMat)));
      roll.add(flap);
      flaps.push(flap);
    }
    g.add(roll);
    rollers.push({ hub: hubMesh, flaps, phase: 0 });

    if (deep) {
      // the TRANSFER roller sits 0.9 in higher, well clear of the pocket, so it stays a plain
      // barrel — there is nothing for a flap of its to yield to
      const t = new THREE.Mesh(hubGeo, rollerMat);
      t.name = `robot:transfer:${m.edge}`;
      t.scale.set(0.62, 1, 0.62);
      t.position.set(inner, 0, BB_ROLLER_Z + 0.9);
      g.add(cast(t));
      rollers.push({ hub: t, flaps: [], phase: 0 });
      // the BELTS down the inside of each arm, linking the two shafts
      for (const s of [1, -1] as const) {
        const belt = new THREE.Mesh(
          new THREE.BoxGeometry(outer - inner, 0.12, 0.5),
          solidMat(tint3d(SWEEPER, accent, 0.35), 0.8, 0),
        );
        belt.position.set((outer + inner) / 2, s * (f.half - 0.45), BB_ROLLER_Z + 0.45);
        g.add(belt);
      }
    }

    // ── SIDE ROLLERS: two vertical-axis compliant wheels at the mouth's own edges, each carried
    // on a REAR YOKE — a strap above and a strap below, both running from the side arm's own rail
    // to the AXLE and stopping there in a bearing boss.
    //
    // ⚠️ **NOTHING MAY COVER THE WHEEL, AND NOTHING IS DRAWN FORWARD OF THE AXLE LINE EXCEPT THE
    // BOSS** (owner, 2026-09-21, rejecting the housed module this replaced: "The side rollers are
    // rendered as being covered and still sticking out a ton. It cant be covered fully because it
    // needs to actually touch the balls"). The rejected draft capped each wheel with a retainer
    // disc on the wheel's OWN radius, which is exactly the surface that has to be seen doing the
    // work. The yoke stops at `wheelX`; the boss is `BB_SIDE_ROLLER_BOSS_R`, well inside the
    // tread; and the strap rides the arm rail's centreline at `BB_SIDE_ROLLER_YOKE_W` wide, which
    // is what leaves 223° of tread visible from every angle, full height — `config.ts`'s own
    // header on `BB_SIDE_ROLLER_BOSS_R` carries that measurement and the RENDER lane asserts it
    // against a real built group.
    //
    // The PROTRUSION came down with it, 1.90 → `BB_SIDE_ROLLER_PROTRUDE` 1.40 (the axis is now
    // INSIDE the footprint), which is the smallest value that still retrieves straight-on 100 %
    // of the time; `config.ts`'s header on `BB_SIDE_ROLLER_R` carries the 540-drive-in sweep.
    if (kind === 'siderollers') {
      // the yoke rides the arm RAIL's own centreline, and `bbSideRollerYokeY` is that number in
      // `config.ts` so the 2D sprite can place it identically without importing this chunk — the
      // RENDER lane asserts the two agree rather than trusting the copy.
      const armY = bbSideRollerYokeY(f.half);
      const wheelX = tip + BB_SIDE_ROLLER_OUT;
      const wheelZ0 = BB_SIDE_ROLLER_Z - BB_SIDE_ROLLER_H / 2;
      const wheelZ1 = BB_SIDE_ROLLER_Z + BB_SIDE_ROLLER_H / 2;
      const backX = wheelX - BB_SIDE_ROLLER_YOKE_BACK;
      for (const s of [1, -1] as const) {
        const rollerY = s * bbSideRollerY(f.half); // ±: as wide as the chassis, inboard of the arm plane
        const armOuter = s * (armY + armT / 2); // the arm rail's own outboard face
        // ONE yoke strap: a narrow bar from the arm rail to the axle, ending in the bearing BOSS.
        // Built per (z, side) rather than cached across them: `rollerY` and `armY` differ by side
        // and by chassis width, the same reason the belts above are not shared either.
        // ⚠️ **THE STRAP RUNS DIAGONALLY FROM THE RAIL TO THE AXLE, AND THAT IS WHAT KEEPS THE
        // TREAD OPEN.** A strap parallel to the rail cannot reach the axle at all — the rail is
        // `BB_SIDE_ROLLER_YOKE_INSET` off the mouth's edge and the axle another ~1.1 in inboard of
        // that, so a straight bar would end beside the boss, not on it, and its front corners would
        // sit in the tread's own radius square on the 90° line. MEASURED off the built meshes, the
        // diagonal first occludes the tread at 132° off the outward direction (264° open) against
        // the straight bar's 90° (180° open, and the owner asked for ~200°).
        const dv = rollerY - s * armY;
        const du = wheelX - backX;
        const strapLen = Math.hypot(du, dv);
        const strapAng = Math.atan2(dv, du);
        const plate = (z0: number): THREE.BufferGeometry =>
          framePart(`srYoke:${strapLen.toFixed(3)}:${strapAng.toFixed(5)}:${z0.toFixed(3)}:${backX.toFixed(3)}:${(s * armY).toFixed(3)}`, () => {
            const boss = new THREE.CylinderGeometry(BB_SIDE_ROLLER_BOSS_R, BB_SIDE_ROLLER_BOSS_R, BB_SIDE_ROLLER_PLATE_T, 12);
            boss.rotateX(Math.PI / 2);
            boss.translate(wheelX, rollerY, z0 + BB_SIDE_ROLLER_PLATE_T / 2);
            const strap = new THREE.BoxGeometry(strapLen, BB_SIDE_ROLLER_YOKE_W, BB_SIDE_ROLLER_PLATE_T)
              .translate(strapLen / 2, 0, 0)
              .rotateZ(strapAng)
              .translate(backX, s * armY, z0 + BB_SIDE_ROLLER_PLATE_T / 2);
            return [strap, boss];
          });
        for (const [tag, z0] of [
          ['top', wheelZ1],
          ['bot', wheelZ0 - BB_SIDE_ROLLER_PLATE_T],
        ] as const) {
          const yoke = cast(new THREE.Mesh(plate(z0), solidMat(ALU, 0.45, 0.35)));
          yoke.name = `robot:sideroller:yoke:${tag}:${m.edge}`;
          g.add(yoke);
        }
        // the DEAD AXLE the wheel turns on, strap to strap — what makes the pair read as a
        // bearing block rather than two loose shelves.
        const axle = new THREE.CylinderGeometry(0.17, 0.17, wheelZ1 - wheelZ0 + 2 * BB_SIDE_ROLLER_PLATE_T, 8);
        axle.rotateX(Math.PI / 2);
        axle.translate(wheelX, rollerY, BB_SIDE_ROLLER_Z);
        const axleMesh = cast(new THREE.Mesh(axle, solidMat(ALU_DK, 0.5, 0.5)));
        axleMesh.name = `robot:sideroller:axle:${m.edge}`;
        g.add(axleMesh);
        // the WEB tying the two straps together where they leave the arm — entirely BEHIND the
        // wheel's own rear tangent, so it takes nothing off the working arc.
        const webT = INTAKE_RAIL_T * 0.6;
        const webLen = Math.max(0.2, BB_SIDE_ROLLER_YOKE_BACK - BB_SIDE_ROLLER_R);
        const web = boxAt(webLen, webT, wheelZ1 - wheelZ0, backX + webLen / 2, armOuter - (s * webT) / 2, BB_SIDE_ROLLER_Z);
        const webMesh = cast(new THREE.Mesh(web, solidMat(ALU, 0.45, 0.35)));
        webMesh.name = `robot:sideroller:web:${m.edge}`;
        g.add(webMesh);

        // the WHEEL: hub + lugged tread, one group so the whole thing takes `rotation.z`
        const wheel = new THREE.Group();
        wheel.name = `robot:sideroller:${m.edge}:${s === 1 ? 'l' : 'r'}`;
        wheel.add(cast(new THREE.Mesh(sideRollerTreadGeometry(), rollerMat)));
        wheel.add(cast(new THREE.Mesh(sideRollerHubGeometry(), solidMat(ALU, 0.5, 0.4))));
        wheel.position.set(wheelX, rollerY, BB_SIDE_ROLLER_Z);
        g.add(wheel);
        // FUNNEL INWARD: the wheel's leading face (local +x, where an oncoming POLLEN first
        // touches it) carries the ball toward the centreline, not away — for the s=+1 (positive-y)
        // wheel that is -y, which is `sign = -s` about the wheel's own vertical (z) axis; the
        // s=-1 wheel mirrors it. See `BB_SIDE_ROLLER_REACH`'s header for why one wheel, not the
        // pair, does the gripping at a flower.
        sideRollers.push({ mesh: wheel, sign: (-s) as 1 | -1, phase: 0 });
      }
    }

    // ── RAMP: a U-frame pivoting on a bracket under the side arms, folded round the sweeper's own
    // barrel and deployed to wedge under a POLLEN. Built in the PIVOT's own local frame with the
    // rails along local +z — the FOLDED pose, so `pivot.rotation.y = 0` draws it there for free —
    // and eased in `sync` toward `BB_RAMP_DEPLOYED_ROT` (derivation: rotating the folded tip
    // `(0,0,BB_RAMP_L)` by `π/2 + BB_RAMP_ANGLE` about local y lands it at
    // `(BB_RAMP_L·cos(BB_RAMP_ANGLE), 0, −BB_RAMP_L·sin(BB_RAMP_ANGLE))`, which added to the pivot's
    // own position is exactly `(tip + BB_RAMP_OUT, ·, BB_RAMP_TIP_Z)` — `config.ts`'s own numbers,
    // reached by construction rather than typed a second time).
    if (kind === 'ramp') {
      const pivot = new THREE.Group();
      pivot.name = `robot:ramp:${m.edge}`;
      // the pivot sits on the sweeper's own axle line (`BB_RAMP_PIVOT_BACK === BB_ROLLER_FLAP_R`,
      // asserted by the RENDER lane) so the folded rails stand round the barrel, not through it
      pivot.position.set(tip - BB_RAMP_PIVOT_BACK, 0, BB_RAMP_PIVOT_Z);
      g.add(pivot);
      rampPivots.push(pivot);

      const railGeo = framePart(`ramp:rail|${railY.toFixed(2)}`, () => [
        boxAt(BB_RAMP_RAIL_X, BB_RAMP_RAIL_Y, BB_RAMP_L, 0, 0, BB_RAMP_L / 2),
      ]);
      for (const s of [1, -1] as const) {
        const rail = cast(new THREE.Mesh(railGeo, solidMat(ALU, 0.5, 0.3)));
        rail.name = `robot:ramp:rail:${m.edge}:${s === 1 ? 'l' : 'r'}`;
        rail.position.set(0, s * railY, 0);
        pivot.add(rail);
      }
      // the WEDGE, replacing the flat bar (2026-09-20 — `config.ts`'s "THE DEPLOYABLE RAMP"): two
      // boxes, the SAME leading-edge/crest/drop points the physics wedge uses
      // (`chassis3dReachShapes`'s `rampWedgeSegment`). Built as CHILDREN of `pivot` so they fold
      // with the rails, but each carries its OWN additional local tilt on top of the pivot's own
      // swing — `wedgeSegment` solves for the LOCAL rotation that, composed with the pivot's own
      // `π/2 + BB_RAMP_ANGLE` (the settled swing angle both this file and `bodies.ts` reach at
      // full deploy), lands the segment at its target world angle (`BB_RAMP_WEDGE_RISE_ANGLE` or
      // `-BB_RAMP_WEDGE_DROP_ANGLE`) — exact at full deploy, and only cosmetically off during the
      // brief 0.3-s fold/deploy swing itself, when the pivot's own angle is not yet `θ_full`.
      const thetaFull = Math.PI / 2 + BB_RAMP_ANGLE;
      // ONE GROUP, node name `robot:ramp:bar:<edge>` UNCHANGED from the old single-mesh crossbar
      // — the RENDER lane finds it by that name and measures it with `mouthExtent`'s own
      // `traverse`, which reads every descendant mesh, so a two-box wedge under this group
      // measures exactly as a one-box crossbar did.
      const wedgeGroup = new THREE.Group();
      wedgeGroup.name = `robot:ramp:bar:${m.edge}`;
      pivot.add(wedgeGroup);
      const wedgeSegment = (u0: number, z0: number, u1: number, z1: number, worldAngle: number, tag: string): void => {
        const length = Math.hypot(u1 - u0, z1 - z0);
        // ⚠️ the two points are the ramp's TOP SURFACE and the box HANGS BELOW them — the same
        // rule (and the same arithmetic) as `sim3d/bodies.ts`'s `rampWedgeSegment`, which is what
        // makes `BB_RAMP_FLOOR_Z` the drawn underside too. The RENDER lane pins both to config.
        const uMid = (u0 + u1) / 2 + (BB_RAMP_WEDGE_THICK * (z1 - z0)) / length;
        const zMid = (z0 + z1) / 2 - (BB_RAMP_WEDGE_THICK * (u1 - u0)) / length;
        // mouth-frame (u, z), relative to the pivot (`u = tip − BB_RAMP_PIVOT_BACK` local-x-wise),
        // rotated by `−θ_full` into the pivot's own UN-rotated ("folded") local frame — the inverse
        // of the same rotation this docstring's derivation above applies forward.
        const dx = uMid + BB_RAMP_PIVOT_BACK;
        const dz = zMid - BB_RAMP_PIVOT_Z;
        const cosT = Math.cos(thetaFull);
        const sinT = Math.sin(thetaFull);
        const lx = dx * cosT - dz * sinT;
        const lz = dx * sinT + dz * cosT;
        const geo = framePart(`ramp:wedge:${tag}|${length.toFixed(2)}|${railY.toFixed(2)}`, () => [
          boxAt(length, railY * 2, BB_RAMP_WEDGE_THICK * 2, 0, 0, 0),
        ]);
        const mesh = cast(new THREE.Mesh(geo, solidMat(ALU, 0.5, 0.3)));
        mesh.name = `robot:ramp:bar:${m.edge}:${tag}`;
        mesh.position.set(lx, 0, lz);
        mesh.rotation.y = worldAngle - thetaFull;
        wedgeGroup.add(mesh);
      };
      wedgeSegment(BB_RAMP_IN, BB_RAMP_DECK_Z, BB_RAMP_OUT, BB_RAMP_DECK_Z, 0, 'deck');

      // the pivot BRACKET is fixed to the chassis (it does not rotate with the ramp) — a short
      // strap hanging from each side arm's own rail down to the pivot axle
      const pivotArmY = f.half - BB_INTAKE_ARM_INSET - armT / 2;
      const pivotBracketGeo = framePart(`ramp:pivotbracket:${(tip - BB_RAMP_PIVOT_BACK).toFixed(2)}`, () => [
        boxAt(
          INTAKE_RAIL_T * 0.6,
          INTAKE_RAIL_T * 0.6,
          Math.abs(railZ - BB_RAMP_PIVOT_Z),
          tip - BB_RAMP_PIVOT_BACK,
          0,
          (railZ + BB_RAMP_PIVOT_Z) / 2,
        ),
      ]);
      for (const s of [1, -1] as const) {
        const pb = cast(new THREE.Mesh(pivotBracketGeo, solidMat(ALU, 0.45, 0.35)));
        pb.name = `robot:ramp:pivotbracket:${m.edge}`;
        pb.position.set(0, s * pivotArmY, 0);
        g.add(pb);
      }
    }

    nodes.push(g);
  }
  return { nodes, rollers, sideRollers, rampPivots };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOODED FLYWHEEL — AND EVERY DIMENSION IN IT COMES OUT OF `config.ts`
//
// ⚠️ **THIS SECTION USED TO OWN THE SHOOTER'S DIMENSION CHAIN PRIVATELY, AND THAT IS WHY IT TOOK
// SIX PASSES.** The flywheel radius, the hood radius, the side-plate profile and the muzzle
// height were local `const`s in this file; the sim owned `BB_LAUNCH_Z0`. Two numbers, two owners,
// and every round of feedback moved one of them to answer the last complaint — so the picture and
// the physics agreed at ONE elevation and nowhere else, and the next look found the next
// disagreement.
//
// The chain lives in `config.ts` now and `bbMuzzleLocal` (`robot.ts`) is the ONE function that
// turns an elevation into a release; both are IMPORTED at the top of this file. **Nothing below
// re-derives a length the sim also knows.** What is still declared here is what exists only in
// the picture — material thicknesses, the belt, the pulleys — and even those are derived wherever
// the chain already fixes them.
//
// THE THREE NODES, AND THE TWO FRAMES THEY MAKE:
//  · `bb-turret-head` (YAW) has its origin on the turret's ROTATION AXIS, at deck height. That is
//    the TURRET frame, and the turret plate — the one part centred on the axis — is built in it.
//  · `bb-turret-axle` (FIXED) hangs under it at `(axleX, 0, BB_TURRET_AXLE_Z)`. That is the AXLE
//    frame every θ in `config.ts` is measured in: +x the shot direction at rest, +z up, θ CCW
//    from +x, the exit at θ = 90° and the feed pinch at θ = 180°.
//  · `bb-turret-pitch` (ELEVATION) sits at the axle node's own origin and carries the hood arc and
//    its two arms and NOTHING ELSE — the flywheel, both side plates, the braces, the motor, the
//    belt and the feed throat are all on the fixed node, so no number can make them move.
//
// ⚠️ **THE AXLE NODE IS NEW, AND IT IS THE OWNER'S SECOND ITEM OF 2026-09-19**: "the flywheel
// should come forward more so that the location where the balls contact the flywheel initially as
// it comes up is roughly in the center of the turret". The axle used to sit ON the rotation axis,
// which meant the element had to be fed in from somewhere off to the back. It is fed THROUGH THE
// RING BEARING now, straight up the rotation axis, and the wheel moved forward by `axleX` to meet
// it there.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * the flywheel as DRAWN: **ONE compliant wheel, centred on the channel.**
 *
 * ⚠️ **OWNER, 2026-09-19: "the flywheel on the shooter looks like there are two wheels stacked
 * next to each other. there should just be one in the center."** It was exactly that — two
 * 0.9-in wheels at y = ±0.7 with a 0.5-in gap between them, a stack 2.3 in wide in a 3.1-in
 * channel, which from any angle reads as two discs and leaves no shaft showing. There was no
 * seam and no groove to fix: the cause was two meshes, and one mesh is the fix.
 *
 * The RADIUS and the axle are the sim's (72 mm, `BB_FLYWHEEL_D_MM`, and `BbHeadDims.axleX`) and
 * nothing here may touch them. The WIDTH is the picture's, and it is DERIVED: half an element
 * diameter, i.e. one element RADIUS, which is 1.40 in on a POLLEN head and 1.80 on a NECTAR one.
 * That grips the middle half of the ball it pinches — a real FTC shooter's single compliant wheel
 * — and leaves `(plateGap − w) / 2` of bare shaft to each side plate (0.85 and 1.05), so the
 * through-axle and its spacers are visible rather than buried in tyre.
 */
const BB_FLYWHEEL_W_FRAC = 0.5;
/** the wheel's HUB, as a fraction of its radius: the boss the shaft keys into, drawn so the tyre
 *  reads as a tyre on a hub and not as a solid puck. */
const BB_FLYWHEEL_HUB_FRAC = 0.42;
/** the spacer collars either side of the wheel, which are what keep it centred on the shaft. */
const BB_FLYWHEEL_SPACER_R = 0.38;

/** the two pulleys and the belt between them. The SITE of the motor is `BbHeadDims.motorR`
 * (derived, in `config.ts`); the pulley radii and the belt section are the picture's. APPROX. */
const BB_FW_PULLEY_R = 0.68;
const BB_MOTOR_PULLEY_R = 0.54;
const BB_BELT_T = 0.16;
const BB_BELT_W = 0.35;
/**
 * ⚠️ **THE BELT RUNS OUTBOARD OF A SIDE PLATE, AND IT HAS TO.** It used to run in the flywheel's
 * own centre gap, which worked while the motor sat in front of the wheel. The motor is BEHIND the
 * hood now (owner item a), and the hood's shell — a disc of radius `hoodR + BB_HOOD_T` sweeping
 * from θ = 90° to 202° — lies across every straight line from the axle to it. So the flywheel
 * axle carries its pulley OUTSIDE the plate, the motor's shaft reaches out to meet it, and the
 * belt runs down the plate's outer face, which is where an FTC shooter's belt usually is anyway.
 * This is how far outboard of that face it sits.
 */
const BB_BELT_CLEAR = 0.25;

/** the AXLE-FRAME angle of the hood's exit lip: straight up over the wheel, at every pitch,
 * because the hood's own frame elevates with it. */
const TH_EXIT = Math.PI / 2;

/**
 * THE FIXED SIDE PLATE'S OUTER BOUNDARY at one axle-frame angle — FIVE HALF-PLANES, and nothing
 * else. The plate is CONVEX and the axle is inside it, so one radius per angle is the whole shape:
 *
 *     r(θ) = min( BB_SIDE_PLATE_TOP_Z    / sin θ   (sin θ > 0),
 *                 BB_SIDE_PLATE_BOTTOM_Z / sin θ   (sin θ < 0),
 *                 BB_SIDE_PLATE_FRONT_X  / cos θ   (cos θ > 0),
 *                 H.sideRearX            / cos θ   (cos θ < 0),
 *                 c_undercut             / (n · u) (n · u < 0) )
 *
 * A flat TOP at the outgoing corridor's ceiling, a flat FRONT past the standoffs, a flat BOTTOM on
 * the turret plate, a flat REAR at the motor's mount station, and the UNDERCUT that takes the
 * bottom up from the back of the feed wall into the motor boss. On a 17-in chassis it is 21.4 sq
 * in of plate (NECTAR 23.5). `sideRearX` and the undercut's offset are the per-head terms.
 *
 * ── ⚠️ ONE PLATE, MOTOR MOUNT TO AXLE TO STANDOFFS ───────────────────────────────────────────
 * Owner, 2026-09-21: "the plate in the back that mounts the motor and the plate that retains the
 * flywheel should be the same plate." The rear used to be closed by an ARC at `hoodR` — the plate
 * stopped 0.63 in short of the feed wall's own back face — and the motor hung off two EARS carried
 * by that wall, a 1.47 × 0.22-in slab in the side plate's exact plane. Two pieces per side, a
 * perpendicular piece between them, and a step you could see. The arc is gone: past the wheel the
 * profile is a straight top and a straight underside meeting a straight rear edge.
 *
 * The rear edge is at `sideRearX`, which is where the TURRET plate already ended (`plateBackX` —
 * both are the motor's mount station), so the head's rear-most extent is unchanged and no slew
 * envelope moved. The UNDERCUT is not a taste line either: it is the common tangent through the
 * bottom flat at the feed wall's back face and around the motor's can plus `BB_MOTOR_MOUNT_RIM`,
 * so the plate is full depth wherever it stands on the turret plate and carries the feed, then
 * tapers into a mount that keeps one rim of material around the can everywhere. Its normal is the
 * SAME on both heads — the wall-to-motor offset is `BB_TURRET_MOTOR_GAP + BB_TURRET_MOTOR_R`
 * whatever the element is — so the rake is one angle, 38.9°, and only the offset differs.
 *
 * ── ⚠️ A FIXED PLATE MUST NOT BE SIZED TO A PART THAT MOVES AWAY FROM IT ─────────────────────
 * Two passes tried to answer "the hood floats 3 in above anything fixed" by GROWING this plate up
 * to the hood — first a 22° relief ramp and a 64° arc (a teardrop with a hump over the feed), then
 * an exit cut and a raked tail (cleaner, still wrong). Both are the same mistake, and the 80° pose
 * is where it shows: the hood swings down behind the wheel and leaves two bare fins standing at
 * `hoodR` with nothing on top of them. The owner said so twice — "the arc in the parallel plates
 * reaches too high", then "the shooter parallel plates became ugly. remember that the arc does not
 * need to be big."
 *
 * **Nobody ever complained about the plate's HEIGHT after that.** What was wrong was never the
 * plate's top: it was that the hood hung off two 0.26-in spokes. The hood carries its own CHEEKS
 * instead — see `buildHoodNode` — and the thing that has to reach the hood is the thing that moves
 * with it. Reaching BACKWARD to the motor is a different axis and a different complaint: the top
 * cut did not move for it, and the ratchet on how high this profile reaches did not either.
 *
 * ⚠️ **AND THE WHEEL-TO-HOOD GAP IS NOT WHAT MOVED — IT NEVER IS.** That gap is one element
 * diameter less the compression; it is the channel the element travels up, and `bbMuzzleLocal` is
 * measured off it. Nothing about `hoodR`, the release, or any constant in `config.ts` changes for
 * a picture fix. What changes is how much PLATE is left, which `BB_SIDE_PLATE_TOP_Z` is the only
 * reader of: grep it — it appears in this file and in its own doc comment, never in `robot.ts`.
 */
/**
 * THE UNDERCUT, as a line `n · p = c` in the axle frame with the plate on the `n · p ≥ c` side.
 *
 * It runs from the bottom flat at the feed wall's own back face — the last station the plate has
 * to be full depth at, because that is where it stands on the turret plate and cheeks the feed —
 * tangent to the motor's can plus `BB_MOTOR_MOUNT_RIM`. Tangency is what makes it a mount rather
 * than a cut: one rim of material all the way round the can, at every x, without a second
 * constant to tune. `n` is head-independent (the wall-to-can offset is `GAP + MOTOR_R` on both
 * heads); only `c`, which is `n · P`, moves with the wall.
 */
function plateUndercut(H: BbHeadDims): { nx: number; nz: number; c: number } {
  const px = -(H.wallR + BB_FEED_WALL_T); // the wall's own back face, on the bottom flat
  const pz = BB_SIDE_PLATE_BOTTOM_Z;
  const dx = -H.motorR - px;
  const dz = -pz;
  const d = Math.hypot(dx, dz);
  const boss = BB_TURRET_MOTOR_R + BB_MOTOR_MOUNT_RIM;
  // rotate the unit vector P→C by −acos(boss/d): the normal that puts the can exactly `boss` above
  // the line, with the line through P
  const ca = boss / d;
  const sa = Math.sqrt(1 - ca * ca);
  const nx = (dx * ca + dz * sa) / d;
  const nz = (-dx * sa + dz * ca) / d;
  return { nx, nz, c: nx * px + nz * pz };
}

function sidePlateR(th: number, H: BbHeadDims): number {
  const st = Math.sin(th);
  const ct = Math.cos(th);
  let r = Infinity;
  if (st > 1e-9) r = Math.min(r, BB_SIDE_PLATE_TOP_Z / st);
  if (st < -1e-9) r = Math.min(r, BB_SIDE_PLATE_BOTTOM_Z / st);
  if (ct > 1e-9) r = Math.min(r, BB_SIDE_PLATE_FRONT_X / ct);
  if (ct < -1e-9) r = Math.min(r, H.sideRearX / ct);
  const u = plateUndercut(H);
  const nu = u.nx * ct + u.nz * st;
  if (nu < -1e-9) r = Math.min(r, u.c / nu);
  return r;
}

/**
 * The angles where the profile above CHANGES WHICH CONSTRAINT BINDS. Sampling alone rounds a
 * corner off; these go into the sample set so every corner is an exact vertex and every flat face
 * is genuinely flat rather than a 0.75° chord. Six of them now: the plate is a convex hexagon.
 */
function sidePlateCorners(H: BbHeadDims): number[] {
  const u = plateUndercut(H);
  // where the undercut meets the bottom flat, and where it meets the rear flat
  const cutBottomX = (u.c - u.nz * BB_SIDE_PLATE_BOTTOM_Z) / u.nx;
  const cutRearZ = (u.c - u.nx * H.sideRearX) / u.nz;
  return [
    Math.atan2(BB_SIDE_PLATE_TOP_Z, BB_SIDE_PLATE_FRONT_X), //                   front ↔ top
    Math.atan2(BB_SIDE_PLATE_TOP_Z, H.sideRearX), //                             top ↔ rear
    Math.PI * 2 + Math.atan2(cutRearZ, H.sideRearX), //                          rear ↔ undercut
    Math.PI * 2 + Math.atan2(BB_SIDE_PLATE_BOTTOM_Z, cutBottomX), //             undercut ↔ bottom
    Math.PI * 2 + Math.atan2(BB_SIDE_PLATE_BOTTOM_Z, BB_SIDE_PLATE_FRONT_X), //  bottom ↔ front
  ];
}

/**
 * An ANNULAR SECTOR in the axle frame (the x–z plane), extruded across the channel.
 *
 * `THREE.ExtrudeGeometry` runs its depth along +z and `rotateX(π/2)` maps the shape's own y to
 * world z and the depth to −y, so the band lands in y ∈ [−depth, 0]; `y0` re-centres it. Every
 * arc part in this section is built through here, so the frame convention is stated once — and
 * the hood cheek's own sector, which needs a bored hole `arcBand` has no argument for, restates
 * those three lines rather than inventing a fourth convention.
 *
 * ⚠️ **A `framePart` LIST MUST NOT MIX INDEXED AND NON-INDEXED BUFFERS.** `mergeGeometries`
 * refuses one — it logs and returns `null`, and `framePart` then falls back to `parts[0]`, so the
 * merge SILENTLY drops every part after the first. An `ExtrudeGeometry` is non-indexed and a
 * `BoxGeometry`/`CylinderGeometry` is indexed, so a hood arm built of both once came out as its
 * rim alone — a hood arc floating on nothing, in a build whose whole point was that the hood has
 * something to hang from (2 of 4 parts survived, measured). Every list in this section is one
 * kind or the other; `toNonIndexed()` is the way across if one ever has to mix.
 */
function arcBand(rIn: number, rOut: number, th0: number, th1: number, depth: number, y0: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, rOut, th0, th1, false);
  if (rIn > 0) shape.absarc(0, 0, rIn, th1, th0, true);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y0 + depth / 2, 0);
  return geo;
}

/**
 * a rounded rectangle in a plate's own PLAN (x fore-aft, y lateral), wound CCW.
 *
 * The turret plate is one of these and its FEED SLOT is another, used as a hole. The slot is a
 * rectangle and not a bore because the hood's tail sweeps down into it at full elevation on the
 * NECTAR head, out at a |y| no circle big enough to pass the element would reach.
 */
function roundedRect<T extends THREE.Path>(p: T, x0: number, x1: number, halfW: number, r: number, cw = false): T {
  // `s` flips the traversal. `ExtrudeGeometry` normalizes an outline it finds counter-clockwise
  // and the holes under it, but NOT the other way round, so the outline is built CCW and each
  // hole CW — the same pairing `platePlane`'s lightening holes use.
  const s = cw ? -1 : 1;
  p.moveTo(x0 + r, -s * halfW);
  p.lineTo(x1 - r, -s * halfW);
  p.quadraticCurveTo(x1, -s * halfW, x1, -s * (halfW - r));
  p.lineTo(x1, s * (halfW - r));
  p.quadraticCurveTo(x1, s * halfW, x1 - r, s * halfW);
  p.lineTo(x0 + r, s * halfW);
  p.quadraticCurveTo(x0, s * halfW, x0, s * (halfW - r));
  p.lineTo(x0, -s * (halfW - r));
  p.quadraticCurveTo(x0, -s * halfW, x0 + r, -s * halfW);
  return p;
}

/**
 * THE HOOD, AND THE ONLY THING THAT ELEVATES WITH IT.
 *
 * ⚠️ **OWNER RULING, VERBATIM: "when the hood is initialising/changing angle, the flywheel should
 * be fixed and the parallel plates should be fixed. Only the hood, a central arc in the back,
 * should be moving up and down."** This group IS that sentence. It pivots on the AXLE (it sits at
 * the axle node's own origin) and it holds the arc, its two CHEEKS and the muzzle node.
 *
 * ── ⚠️ THE HOOD CARRIES ITS OWN CHEEKS, AND THAT IS WHAT REPLACED TWO FAILED ANSWERS ─────────
 * The hood's arc lives at `hoodR … +BB_HOOD_T` and it ELEVATES, so it can never bolt to anything
 * fixed. Two passes tried to solve that by growing the FIXED side plates up to `hoodR` — a relief
 * ramp and a 64° arc, then an exit cut and a raked tail — and both left the 80° pose with two bare
 * fins standing where the hood used to be, because at full elevation the hood has swung down
 * behind the wheel and the plate it was sized to is chasing nothing. See `sidePlateR`.
 *
 * What a real adjustable hood has is a pair of CHEEK PLATES that are part of the hood: a pivot
 * boss on the shooter axle and a solid sector out to the hood's own outer face, spanning the
 * hood's own wrap. Swinging the boss swings the whole bracket, so hood + cheeks read as ONE rigid
 * assembly hinged on the axle at EVERY pitch, and there is no elevation at which anything floats.
 * "The arc does not need to be big" is the sector's size rule: it spans `BB_HOOD_WRAP` and not one
 * degree more, because that is the arc it carries.
 *
 * They run INBOARD, in the lateral band between the element and each side plate, which is where
 * the clearance is: outboard on the drive side the belt and the flywheel pulley own everything
 * past 1.98 in. So a cheek meets exactly two things — the hood, which it IS, and the shaft it is
 * journalled on.
 */
function buildHoodNode(H: BbHeadDims, which: 0 | 1): THREE.Group {
  const pitch = new THREE.Group();
  const halfW = H.elemR;
  // a cheek's lateral width is DERIVED, not chosen: the channel's half, less `BB_HOOD_SIDE_CLEAR`
  // from the side plate's inner face, less the hood. 0.07 in on EITHER head — 14-gauge sheet. The
  // cheeks are the WIDEST thing on this node, so that one constant is the whole hood's clearance
  // to each plate, at every elevation (owner, 2026-09-21: "it should be inside, with a very slight
  // gap" — it was 0.06, which reads as touching).
  //
  // ⚠️ **THE CHEEK'S INBOARD FACE IS THE CHANNEL WALL, AND THAT IS WHY IT MAY CROSS THE ELEMENT'S
  // PATH.** An element is a SPHERE: at lateral offset `elemR` its cross-section is a point, so a
  // member that starts there sweeps no volume the element occupies, at any radius and any angle.
  // That is the only reason a SOLID sector can run from the axle out to the hood — in the x–z
  // PROJECTION there is no such path, because the element fills it.
  const armW = H.plateGap / 2 - BB_HOOD_SIDE_CLEAR - halfW;
  const armHubR = 0.75;
  const thFeed = TH_EXIT + BB_HOOD_WRAP;

  // THE ARC — one element diameter clear of the wheel, less the compression, and `BB_HOOD_T`
  // thick, which is what stands it proud of the plates at every elevation.
  const hoodGeo = framePart(`hood:${which}`, () => [
    arcBand(H.hoodR, H.hoodR + BB_HOOD_T, TH_EXIT, thFeed, halfW * 2, 0),
  ]);
  const hood = new THREE.Mesh(hoodGeo, solidMat(TURRET_BARREL, 0.35, 0.55));
  hood.name = 'bb-turret-hood';
  pitch.add(cast(hood));

  // THE TWO CHEEKS — see the header. One merged part per side; the key carries the side, because
  // the two are mirror images and a shared buffer would put both on one.
  //
  // ⚠️ A SOLID SECTOR, NO LIGHTENING BORE (owner, 2026-09-21: "the shooter's parallel plate should
  // not be split in a half (there shouldn't be a hole for the hood)"). The side plates were never
  // cut — what read as a holed, split plate was THIS arm: a dark sector with a big round bore,
  // standing above the light plate 0.06 in off its face. The bore is gone; the arm is a plain
  // bracket between the plate and the wheel.
  for (const s of [1, -1] as const) {
    const y0 = s * (halfW + armW / 2);
    const cheekGeo = framePart(`hoodCheek:${which}:${s}`, () => {
      const rOut = H.hoodR + BB_HOOD_T;
      const shape = new THREE.Shape();
      shape.absarc(0, 0, rOut, TH_EXIT, thFeed, false);
      shape.lineTo(0, 0);
      shape.closePath();
      const sector = new THREE.ExtrudeGeometry(shape, { depth: armW, bevelEnabled: false, curveSegments: 24 });
      sector.rotateX(Math.PI / 2);
      sector.translate(0, y0 + armW / 2, 0);
      // ...and the boss it pivots on, which is what closes the sector's own apex over the shaft
      return [sector, arcBand(0, armHubR, 0, Math.PI * 2, armW, y0)];
    });
    // ⚠️ THE HOOD'S MATERIAL, NOT THE PLATE'S. A cheek in `ALU` is the same grey as the fixed
    // side plate it sits behind, so the eye groups it with the structure it slides past instead
    // of with the arc it carries — which is the whole claim this bracket exists to make.
    const cheek = new THREE.Mesh(cheekGeo, solidMat(TURRET_BARREL, 0.4, 0.45));
    cheek.name = 'bb-turret-hood-cheek';
    pitch.add(cast(cheek));
  }

  // THE MUZZLE, as a named empty at the hood's LIP — `pathR` straight up from the axle in this
  // node's own frame, which becomes `bbMuzzleLocal(pitch, which)` once the node has turned.
  //
  // ⚠️ IT IS READ OFF `bbMuzzleLocal` ITSELF at the rest pose, where this node's frame and the
  // axle frame coincide, and then shifted by the axle's own forward offset because the sim
  // answers in the TURRET frame. Placing it at a locally written `pathR` would be the same number
  // by a second route, and a second route is how the last five passes disagreed.
  const exit = new THREE.Object3D();
  exit.name = 'bb-turret-exit';
  const rest = bbMuzzleLocal(BB_TURRET_PITCH_MIN, which);
  exit.position.set(-rest.back - H.axleX, 0, rest.z - BB_TURRET_AXLE_Z);
  pitch.add(exit);
  return pitch;
}

/**
 * EVERYTHING ELSE THE SHOOTER IS — and none of it elevates.
 *
 * `axle` is the fixed node at the flywheel axle, so every position added to it is a `config.ts`
 * (θ, r) read off as (cos θ · r, sin θ · r) with no frame shift to get wrong. `head` is the YAW
 * node on the rotation axis, and the only things built in it are the two parts centred on that
 * axis: the turret plate and its feed slot.
 *
 * ⚠️ **NO `accent` ARGUMENT, AND THAT IS THE OWNER'S "keep the flywheel black"** (2026-09-21).
 * The 2026-09-20 cosmetics pass tinted the tyre here; nothing on the shooter takes the accent now,
 * so the parameter is gone rather than left dead. The DRIVE wheels and the intake rollers still
 * take it — see `buildWheels`/`buildIntake`.
 */
function addFixedShooter(head: THREE.Group, axle: THREE.Group, H: BbHeadDims, which: 0 | 1): void {
  // ── THE TURRET PLATE, ON THE SLEW RING, CUT THROUGH FOR THE FEED ──────────────────────────
  // ⚠️ THE SLOT IS THE POINT. The element comes up the rotation axis, through the ring bearing's
  // bore and through this plate, which is what makes the feed path something you can see rather
  // than something a comment claims. It is a rounded RECTANGLE, not a bore: on the NECTAR head
  // the hood's tail dips 0.14 in below the plate at full elevation, at a radius a circle big
  // enough to pass the element would not reach.
  const plateGeo = framePart(`turretPlate:${which}`, () => {
    const shape = roundedRect(new THREE.Shape(), H.plateBackX, H.plateFrontX, H.plateHalfW, 0.5);
    shape.holes.push(roundedRect(new THREE.Path(), H.slotBackX, H.slotFrontX, H.slotHalfW, 0.25, true));
    const g = new THREE.ExtrudeGeometry(shape, { depth: BB_TURRET_PLATE_T, bevelEnabled: false, curveSegments: 8 });
    g.translate(0, 0, BB_TURRET_PLATE_TOP_Z - BB_DECK_Z - BB_TURRET_PLATE_T);
    return [g];
  });
  const turretPlate = new THREE.Mesh(plateGeo, solidMat(ALU_DK, 0.45, 0.4));
  turretPlate.name = 'bb-turret-plate';
  head.add(cast(turretPlate));

  // ── THE TWO SIDE PLATES — `sidePlateR`, sampled, with its four corners exact ───────────────
  // SOLID, not a band with a bore: a side plate is what the flywheel is JOURNALLED in, and the
  // bare annulus an earlier band left between its hub and its rim is what made the wheel read as
  // unconstrained. Everywhere the flat top does not cut it, the plate is behind the wheel's rim.
  //
  // ⚠️ **ONE PIECE, NO SLOT AND NO HOOD-SHAPED HOLE** (owner, 2026-09-21: "the shooter's parallel
  // plate should not be split in a half (there shouldn't be a hole for the hood)"). One outline,
  // no `shape.holes`, one extrusion — measured, 1 connected component, 0 boundary loops, χ=2, so
  // genus 0. The hood never needed a slot: its arms pivot on the axle INSIDE the channel,
  // `BB_HOOD_SIDE_CLEAR` clear of this face. `hoodPlateChecks` pins all of it.
  //
  // ⚠️ **AND ONE PIECE FROM THE MOTOR MOUNT TO THE MUZZLE** (owner, 2026-09-21, second correction:
  // "the plate in the back that mounts the motor and the plate that retains the flywheel should be
  // the same plate"). It is the same extrusion of the same outline — `sidePlateR` is simply the
  // whole plate now, rear flat included, so there is no seam to draw and nothing to keep in step.
  // The genus-0 ruling is also why there are no bolt HOLES in it: a hole is a hole to the check
  // that caught the hood-shaped one, and the pilot is where `bb-turret-shaft` crosses the plate.
  const sideGeo = framePart(`shooterSidePlate:${which}`, () => {
    const angles: number[] = [];
    const N = 480;
    for (let i = 0; i < N; i++) angles.push((Math.PI * 2 * i) / N);
    for (const c of sidePlateCorners(H)) angles.push(((c % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
    angles.sort((a, b) => a - b);
    const shape = new THREE.Shape();
    angles.forEach((th, i) => {
      const r = sidePlateR(th, H);
      const x = Math.cos(th) * r;
      const y = Math.sin(th) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: BB_SHOOTER_PLATE_T, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    return [geo];
  });
  for (const s of [1, -1] as const) {
    const plate = new THREE.Mesh(sideGeo, solidMat(ALU, 0.4, 0.45));
    plate.name = 'bb-turret-side-plate';
    // the geometry runs y ∈ [−t, 0], so this puts each plate's INNER face on the channel wall
    plate.position.y = s > 0 ? H.plateGap / 2 + BB_SHOOTER_PLATE_T : -H.plateGap / 2;
    axle.add(cast(plate));
  }

  // ── THE FLYWHEEL — ONE WHEEL, CENTRED, ONE BEARING BLOCK ABOVE THE TURRET PLATE ───────────
  // Its height is not this file's to choose: `BB_TURRET_AXLE_Z` is the turret plate plus
  // `BB_FLYWHEEL_CLEAR` plus the radius, so the wheel sits where a flywheel shooter's wheel sits,
  // and the hood, the muzzle and the release all follow it. Its FORWARD position is not this
  // file's either — the axle node carries `axleX`, and that is what puts the first contact on the
  // turret's own rotation axis. Its LATERAL position is y = 0, dead centre of the channel: see
  // `BB_FLYWHEEL_W_FRAC` for the owner report that is.
  //
  // ⚠️ AND ITS COLOUR IS `SWEEPER`, FLAT, WHATEVER THE COSMETICS SAY (owner, 2026-09-21: "keep the
  // flywheel black"). It was `tint3d(SWEEPER, accent, 0.5)` for one day; a magenta accent made the
  // one part of the machine that is obviously a compliant tyre read as painted plastic.
  const fwW = H.elemR * 2 * BB_FLYWHEEL_W_FRAC;
  const wheel = new THREE.Mesh(wheelGeometry(BB_FLYWHEEL_R, fwW), solidMat(SWEEPER, 0.45, 0.2));
  wheel.name = 'bb-turret-flywheel';
  axle.add(cast(wheel));
  // the HUB inside it, and a spacer collar each side — a wheel on a shaft rather than a puck
  const hubGeo = framePart(`flywheelHub:${which}`, () => {
    const parts: THREE.BufferGeometry[] = [
      new THREE.CylinderGeometry(BB_FLYWHEEL_R * BB_FLYWHEEL_HUB_FRAC, BB_FLYWHEEL_R * BB_FLYWHEEL_HUB_FRAC, fwW + 0.06, 12),
    ];
    for (const s of [1, -1] as const) {
      parts.push(new THREE.CylinderGeometry(BB_FLYWHEEL_SPACER_R, BB_FLYWHEEL_SPACER_R, 0.3, 10).translate(0, s * (fwW / 2 + 0.15), 0));
    }
    return parts;
  });
  const hub = new THREE.Mesh(hubGeo, solidMat(ALU_DK, 0.35, 0.6));
  hub.name = 'bb-turret-flywheel-hub';
  axle.add(cast(hub));
  const beltY = H.plateGap / 2 + BB_SHOOTER_PLATE_T + BB_BELT_CLEAR + BB_BELT_W / 2;
  const shaftIn = -(H.plateGap / 2 + BB_SHOOTER_PLATE_T + 0.15);
  const shaftOut = beltY + BB_BELT_W / 2 + 0.1;

  // ── THE CROSS BRACES — `BB_TURRET_BRACES`, which is a MEASURED site list ───────────────────
  // All three are in the FRONT quadrant, because that is the only interior the machine has left:
  // the element rises up the rotation axis and is carried from θ = 180° round to the lip, and the
  // hood sweeps everything outside that. Nothing is adjusted here — this draws the list.
  const braceGeo = framePart(`shooterBrace:${which}`, () =>
    BB_TURRET_BRACES.map((site) => {
      const g = new THREE.CylinderGeometry(BB_TURRET_BRACE_R, BB_TURRET_BRACE_R, H.tieSpan, 10);
      g.translate(Math.cos(site.th) * site.r, 0, Math.sin(site.th) * site.r);
      return g;
    }),
  );
  const braces = new THREE.Mesh(braceGeo, solidMat(ALU, 0.35, 0.55));
  braces.name = 'bb-turret-brace';
  axle.add(cast(braces));

  // ── THE FEED THROAT — THE BACK OF THE CHANNEL THE ELEMENT COMES UP, AND THE REAR TIE ──────
  // ⚠️ **THIS IS WHAT REPLACES THE "WEIRD FLAP IN THE BACK", REPORTED TWICE.** The first answer
  // was a loose plank and the second was a FEED SHOE — an arc hanging outboard of the hood,
  // bolted to the plates on paper and touching nothing you could see on screen. The feed comes up
  // the rotation axis now, so the two side plates ARE the throat's cheeks and the only missing
  // part is its BACK: one flat vertical wall standing on the turret plate, `BB_FEED_SLIDE` clear
  // of the hood's outermost swept radius (a plane outside that radius clears the hood at every
  // elevation, with no angular bookkeeping). It spans the channel and both plates, so it is the
  // rear tie — a plain cross member, exactly like the front standoffs.
  //
  // ⚠️ **AND ITS TWO EARS ARE GONE** (owner, 2026-09-21). They carried the motor: a slab in the
  // side plate's OWN plane, 0.63 in behind the plate's rear-most point, with this wall's
  // perpendicular face in the gap — which is a second plate standing in for the side plate, and it
  // is what the owner saw as a split. The side plate reaches the motor itself now. What is left
  // here crosses the channel and nothing else, which is the test a member has to pass.
  //
  // ⚠️ **AND IT STOPS AT THE PLATES' INNER FACES, UNDER THEIR TOP EDGE** (owner, 2026-09-21, third
  // pass: the plate must read as ONE piece). It used to span `H.tieSpan` — through both side
  // plates and `BB_BRACE_PROUD` past each outer face, at exactly the plates' own height — so from
  // outside it drew a vertical rib across each plate and a line along its top: a one-piece plate
  // that still LOOKED split, right where the old ear used to start. A wall between two plates is
  // fastened through them with screws, it does not pass through them.
  const wallX = -(H.wallR + BB_FEED_WALL_T / 2);
  const wallTop = BB_SIDE_PLATE_TOP_Z - 0.06;
  const throatGeo = framePart(`feedThroat:${which}`, () => [
    boxAt(BB_FEED_WALL_T, H.plateGap, wallTop - BB_SIDE_PLATE_BOTTOM_Z, wallX, 0, (wallTop + BB_SIDE_PLATE_BOTTOM_Z) / 2),
  ]);
  const throat = new THREE.Mesh(throatGeo, solidMat(ALU, 0.4, 0.45));
  throat.name = 'bb-turret-throat';
  axle.add(cast(throat));

  // ── THE MOTOR, BEHIND THE HOOD, FACE-BOLTED TO THE DRIVE-SIDE PLATE ───────────────────────
  // ⚠️ OWNER ITEM (a): "the motor should be on the other side of the flywheel, behind the hood."
  // It sat at θ = −15°, in front of and under the wheel. `BbHeadDims.motorR` puts it at θ = 180°
  // — dead behind the axle and level with it — just clear of the feed wall, which is the only
  // pocket left once the hood sweeps 90°…202° and the element owns everything inside that.
  //
  // ⚠️ **ITS FACE IS ON A SIDE PLATE** (owner, 2026-09-21). The can's axis is LATERAL, so the only
  // parts it can face-mount to are the y = const planes — the two side plates — and the plate now
  // reaches it. Its output face sits exactly on the BELT side's inner face (+y), the shaft passes
  // through the plate to its pulley, and the belt runs down that same plate's outer face to the
  // flywheel: one plate carries the motor, the drive and the axle. INBOARD rather than outboard,
  // from the numbers: the can is drawn one channel long less a working clearance (3.00 in on a
  // POLLEN head, 3.80 on a NECTAR one) and a 1.42-in can hung outboard would stand the belt plane
  // ~2 in further out on the drive side for nothing the picture gains.
  const mx = -H.motorR;
  const motorFaceY = H.plateGap / 2; // the drive-side plate's inner face
  const motorLen = H.plateGap - 0.1;
  // ⚠️ THE CAN AND NOTHING ELSE. Its output SHAFT is part of `bb-turret-shaft` below: the lane's
  // "between the plates" measurement is about the can, and a shaft merged in here would put the
  // motor's own vertices out at the belt's plane and make that reading a lie.
  const motorGeo = framePart(`shooterMotor:${which}`, () => [
    new THREE.CylinderGeometry(BB_TURRET_MOTOR_R, BB_TURRET_MOTOR_R, motorLen, 12).translate(mx, motorFaceY - motorLen / 2, 0),
  ]);
  const motor = new THREE.Mesh(motorGeo, solidMat(MOTOR, 0.5, 0.4));
  motor.name = 'bb-turret-motor';
  axle.add(cast(motor));

  // ── THE TWO SHAFTS — the flywheel's, which runs right through and out the belt side to carry
  // its pulley, and the motor's output, which reaches out to meet it. Both cross a side plate
  // because the belt has to run outboard of one.
  // the motor's own reaches from its mounting FACE — which is the plate's inner face, so the shaft
  // crosses the plate the way a real one crosses its mount's pilot bore, and the pulley lands
  // outboard beside the flywheel's.
  const shaftGeo = framePart(`shooterShaft:${which}`, () => [
    new THREE.CylinderGeometry(0.26, 0.26, shaftOut - shaftIn, 8).translate(0, (shaftIn + shaftOut) / 2, 0),
    new THREE.CylinderGeometry(0.16, 0.16, shaftOut - motorFaceY, 8).translate(mx, (shaftOut + motorFaceY) / 2, 0),
  ]);
  const shaft = new THREE.Mesh(shaftGeo, solidMat(ALU, 0.3, 0.7));
  shaft.name = 'bb-turret-shaft';
  axle.add(cast(shaft));

  // THE BELT — two pulleys and the two straight tangent runs between them, merged into one part,
  // in a plane `BB_BELT_CLEAR` outboard of the side plate's outer face. A `TubeGeometry` over a
  // closed spline is the obvious alternative and costs ~20× the vertices for a loop 0.16 thick.
  const beltGeo = framePart(`shooterBelt:${which}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    for (const [r, x] of [
      [BB_FW_PULLEY_R, 0],
      [BB_MOTOR_PULLEY_R, mx],
    ] as const) {
      const p = new THREE.CylinderGeometry(r, r, BB_BELT_W + 0.08, 14);
      p.translate(x, beltY, 0);
      parts.push(p);
    }
    // the external tangents of two circles of radii R1, R2 a distance d apart leave each centre
    // along the SAME unit normal, offset from the centre line by asin((R1 − R2) / d)
    const d = H.motorR;
    const off = Math.asin((BB_FW_PULLEY_R - BB_MOTOR_PULLEY_R) / d);
    const runLen = Math.sqrt(d * d - (BB_FW_PULLEY_R - BB_MOTOR_PULLEY_R) ** 2);
    for (const s of [1, -1] as const) {
      const u = Math.PI + s * (Math.PI / 2 + off);
      const ax = Math.cos(u) * BB_FW_PULLEY_R;
      const az = Math.sin(u) * BB_FW_PULLEY_R;
      const bx = mx + Math.cos(u) * BB_MOTOR_PULLEY_R;
      const bz = Math.sin(u) * BB_MOTOR_PULLEY_R;
      const g = new THREE.BoxGeometry(runLen, BB_BELT_W, BB_BELT_T);
      g.rotateY(-Math.atan2(bz - az, bx - ax));
      g.translate((ax + bx) / 2, beltY, (az + bz) / 2);
      parts.push(g);
    }
    return parts;
  });
  const belt = new THREE.Mesh(beltGeo, solidMat(ALU_DK, 0.55, 0.3));
  belt.name = 'bb-turret-belt';
  axle.add(cast(belt));
}

/**
 * ONE TURRET, BOLTED TO THE DECK.
 *
 * ⚠️ `BB_DECK_Z`, NOT 0 AND NOT `heightIn` — and both mistakes have shipped. Day 1 put the ring
 * at z = 1, INSIDE the chassis box, so every robot was a featureless slab; the fix then raised it
 * to the top of the full-height box, which stood the shooter a foot and a half up in the air for
 * no reason anything could see. It is bolted to the DECK, like the real thing.
 *
 * `which` is the exit this head is: 0 is the POLLEN turret every turreted build has, 1 the DOUBLE
 * turret's NECTAR turret. It picks the head's whole dimension set (`bbHead`), so a NECTAR head is
 * visibly the bigger machine — bigger hood, wider channel, axle further forward, muzzle 0.4 in
 * higher. Every `framePart` key below carries it, or the two would share one buffer.
 *
 * THE NODE NAMES ARE AN INTERFACE. `bb-turret-head` is the YAW pivot (it carries the turret's own
 * world heading minus the chassis's) and `bb-turret-pitch` is the ELEVATION pivot, with
 * `bb-turret-exit` the muzzle under it. `bb-turret-axle` is the fixed node BETWEEN them, and it is
 * what moved the wheel forward of the rotation axis; the per-frame sync writes the same two
 * rotations, in the same order, with the same signs.
 *
 * EXPORTED for `scripts/smoke-biobuzz/render.ts`, which BUILDS this group and MEASURES it at
 * sampled elevations rather than reading the source and trusting it. Five passes were signed off
 * by a lane that only ever grepped for literals; a check that cannot see the geometry cannot see
 * the bug. It is not imported anywhere in `src/` — `buildRobotGroup` below is still the one
 * generator the match and the builder share.
 */
export function buildTurret(spec: RobotSpec, mountPos: BbMountPos, which: 0 | 1 = 0): THREE.Group {
  const group = new THREE.Group();
  const H = bbHead(which);
  const ring = turretRadius(spec);
  const local = turretLocal(spec, mountPos);
  group.name = 'bb-turret';
  group.position.set(local.x, local.y, BB_DECK_Z);

  // THE SLEW RING STAYS WITH THE CHASSIS — the toothed outer race is bolted to the frame and the
  // head turns on it, which is the same statement `drawRobot.ts` makes in 2D. It is BORED, because
  // the feed comes up through it; the bore passes the element and stops short of the race.
  const ringBore = Math.min(H.elemR + 0.25, Math.max(0.2, ring - 0.45));
  const ringGeo = framePart(`turretRing:${ring.toFixed(4)}:${which}`, () => {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, ring, 0, Math.PI * 2, false);
    const bore = new THREE.Path();
    bore.absarc(0, 0, ringBore, 0, Math.PI * 2, true);
    shape.holes.push(bore);
    return [new THREE.ExtrudeGeometry(shape, { depth: BB_TURRET_RING_H, bevelEnabled: false, curveSegments: 24 })];
  });
  const ringMesh = new THREE.Mesh(ringGeo, solidMat(TURRET_RING, 0.4, 0.5));
  ringMesh.name = 'bb-turret-ring';
  group.add(cast(ringMesh));

  // ⚠️ THE YAW NODE'S ORIGIN IS THE ROTATION AXIS, AT DECK HEIGHT, AND IT USED TO BE THE AXLE.
  // It has to be the axis: `rotation.z` turns this node's children about its own origin, so with
  // the axle offset forward the axle has to ORBIT the axis, which only happens if the offset is
  // inside the node rather than on it.
  const head = new THREE.Group();
  head.name = 'bb-turret-head';

  // THE FIXED NODE AT THE FLYWHEEL AXLE — the AXLE FRAME, `axleX` forward and `BB_TURRET_AXLE_Z`
  // up. Everything but the turret plate hangs off it, and the PITCH node sits at its origin,
  // which is what makes the hood pivot about the axle for free.
  const axle = new THREE.Group();
  axle.name = 'bb-turret-axle';
  axle.position.set(H.axleX, 0, BB_TURRET_AXLE_Z - BB_DECK_Z);
  addFixedShooter(head, axle, H, which);

  const pitch = buildHoodNode(H, which);
  pitch.name = 'bb-turret-pitch';
  axle.add(pitch);
  head.add(axle);
  group.add(head);
  group.userData.head = head;
  group.userData.axle = axle;
  group.userData.pitch = pitch;
  return group;
}

/**
 * ⚠️ **HOW FAR THROUGH ITS THROW A CATAPULT'S ARM IS, AS A PURE FUNCTION OF SIM STATE.**
 *
 * 0 at rest, 1 at the top of the fling. `lastFireAt` is stamped on the tick the bucket leaves
 * (`bbLaunch`) and `BB_DUMP_RELOAD_S` is how long the mechanism takes to re-arm, so the whole
 * animation is those two numbers and `world.time` — **no new per-tick wire field, and nothing
 * stored in the renderer**, which is what lets a spectator, a replay and a reconciled client all
 * draw the same arm at the same instant.
 *
 * The shape is a SNAP and a RETURN: up over `SNAP` of the reload (0.075 s at the shipped 0.75)
 * and easing back over the rest. The fling is one motion, so the picture is one motion.
 */
const DUMP_SNAP = 0.1;
function dumpThrowPhase(world: World, r: RobotState): number {
  const u = (world.time - r.lastFireAt) / BB_DUMP_RELOAD_S;
  if (!(u >= 0) || u >= 1) return 0;
  if (u < DUMP_SNAP) return u / DUMP_SNAP;
  const k = (u - DUMP_SNAP) / (1 - DUMP_SNAP);
  return (1 - k) * (1 - k); // ease out of the throw, slower than it went up
}

/** how far the arm swings at full throw (rad, about the pivot shaft). APPROX. */
const DUMP_THROW_ANGLE = 1.05;

/**
 * THE DUMPER — a CATAPULT, not a flywheel and not a pouring tray: `bbLaunch` flings its whole
 * bucket over one edge in one motion (`bbDumpCluster`, owner 2026-09-19). Two throwing arms off a
 * shaft well inside the frame, a small open bucket between them sized for the four seats, and the
 * release lip at the mounted edge `BB_LAUNCH_Z0` off the tile, so the elements leave where the sim
 * says they do. APPROX size: BIOBUZZ publishes no dumper hardware.
 *
 * ⚠️ **THE ARM IS ITS OWN NODE, PIVOTED ON THE SHAFT.** Everything that swings — floor, arms, back
 * wall, lip — hangs off `bb-dump-arm`, whose origin IS the shaft; the shaft itself and the two
 * posts that carry it stay on the chassis. The per-frame sync rotates that one node by
 * `dumpThrowPhase`, and nothing else about the dumper moves.
 */
function buildDumper(spec: RobotSpec, launcher: BbLauncherSpec): THREE.Group {
  const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
  const { dist, span } = edgeGeom(spec, edge);
  const group = new THREE.Group();
  group.name = 'robot:dumper';
  group.rotation.z = EDGE_ANGLE[edge];
  const half = span * 0.86;
  const pivot = dist - Math.min(8, dist * 0.8);
  const lip = dist - 0.7;
  const len = lip - pivot;
  const shaftZ = BB_LAUNCH_Z0 - 2.3;
  const mat = solidMat(DUMPER_BUCKET, 0.5, 0.3);

  // the FIXED half: the shaft and the posts that stand it off the deck.
  const mount = framePart(`dumpmount:${half.toFixed(2)}|${pivot.toFixed(2)}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const shaft = new THREE.CylinderGeometry(0.34, 0.34, half * 2, 8);
    shaft.translate(pivot, 0, shaftZ);
    parts.push(shaft);
    for (const s of [1, -1] as const) {
      parts.push(boxAt(0.6, 0.6, shaftZ - BB_DECK_Z, pivot, s * (half - 0.3), (shaftZ + BB_DECK_Z) / 2));
    }
    return parts;
  });
  group.add(cast(new THREE.Mesh(mount, mat)));

  // the SWINGING half, built about the shaft so the node's own rotation IS the throw.
  const arm = new THREE.Group();
  arm.name = 'bb-dump-arm';
  arm.position.set(pivot, 0, shaftZ);
  const tray = framePart(`dumper:${len.toFixed(2)}|${half.toFixed(2)}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const dz = BB_LAUNCH_Z0 - shaftZ;
    // floor, tilted up toward the lip
    const floor = new THREE.BoxGeometry(len, half * 2, 0.22);
    floor.rotateY(-0.22);
    floor.translate(len / 2, 0, dz - 1.5);
    parts.push(floor);
    // the two throwing arms, and the lip they end in
    for (const s of [1, -1] as const) {
      const a = new THREE.BoxGeometry(len, 0.3, 1.9);
      a.rotateY(-0.22);
      a.translate(len / 2, s * (half - 0.15), dz - 1.1);
      parts.push(a);
    }
    parts.push(boxAt(0.6, half * 2, 0.5, len, 0, dz - 0.25));
    // the BACK WALL over the pivot — without it the tray reads as a plank rather than a bucket
    parts.push(boxAt(0.3, half * 2, 2.6, 0.4, 0, dz - 2.4));
    // ...and the two SIDE WALLS that make it a bucket rather than a trough. The bucket holds four
    // (`BB_DUMP_BUCKET`, two across by two high), so it has to look deep enough to.
    for (const s of [1, -1] as const) {
      parts.push(boxAt(len * 0.8, 0.28, BB_DUMP_SEAT_PITCH, len * 0.45, s * half, dz - 1.2 + BB_DUMP_SEAT_PITCH / 2));
    }
    return parts;
  });
  arm.add(cast(new THREE.Mesh(tray, mat)));
  group.add(arm);
  group.userData.dumpArm = arm;
  return group;
}

/**
 * ONE ROBOT'S `THREE.Group`, BUILT FROM ITS SPEC — and the ONLY generator there is.
 *
 * The builder's 3D preview (`renderPreview.ts`) and the saved-robot thumbnails call THIS
 * function, not a second drawing of the same robot: that is roadmap item 1's stated risk
 * ("preview and match must not drift") answered structurally rather than by a habit. It takes a
 * spec, an id and an alliance rather than a `RobotState` for exactly that reason — a preview has
 * no pose, no hopper and no world, and asking it to fake one would have been the seam where the
 * two pictures started to differ.
 *
 * ── THE ALLIANCE AND THE COSMETIC COLOUR (roadmap item 1) ──────────────────────────────────
 * The chassis FILL is the supporter cosmetic (`chassisFill`, the 7-key allowlist in
 * `src/config.ts`) — it goes on the drivetrain side plates and the deck — and the ALLIANCE is
 * the sign panel (the red/blue silhouette line was removed 2026-09-21; the name label over the
 * robot carries the alliance now). Scoping the cosmetic to the FILL is what keeps it from ever making a red
 * robot read as blue, which is the one thing a cosmetic may not do here.
 */
export function buildRobotGroup(
  spec: RobotSpec,
  id: number,
  alliance: Alliance,
  /** ⚠️ THE TIER'S WHEEL TESSELLATION, AND THE ONLY THING A TIER MAY CHANGE ABOUT THIS ROBOT.
   *  It defaults to `high` so every existing caller — the RENDER lane included — builds exactly
   *  what it built before; the live scene and the builder preview pass their own
   *  (`bbWheelDetail`), and the match's `sync` rebuilds a group when it changes. */
  detail: BbWheelDetail = 'high',
): THREE.Group {
  const group = new THREE.Group();
  group.name = `robot:${id}`;
  const launcher = bbLauncherOf(spec, 0);
  const lift = bbLiftOf(spec);
  // COSMETICS: see `render/drawRobot.ts`'s header — `accent`/`decal`/`plate` land on `RobotSpec`
  // on a parallel lane; `clampCosmetics` is shape-safe against a spec that does not declare them
  // yet. The FILL is the cosmetic (see below); the ALLIANCE is the signs (and the name label).
  const cosm = clampCosmetics(spec);
  const accent = accentFill(cosm.accent, spec.chassisColor);

  for (const part of buildFrame(spec)) group.add(part);
  for (const part of buildEndPlates(spec, id)) group.add(part);
  const wheels = buildWheels(spec, accent, detail);
  for (const w of wheels.nodes) group.add(w);
  // the handles the per-frame sync poses a MOVING drivetrain with. Absent for the three that do
  // not move (a preview has no `RobotState` at all, so both lists are simply empty there).
  group.userData.swervePods = wheels.pods;
  group.userData.butterflySets = { traction: wheels.traction, roller: wheels.roller };
  group.userData.spinWheels = wheels.spin;

  // NO EDGE LINE ROUND THE CHASSIS. There were two — a red/blue ALLIANCE line and a dark halo under
  // it. The owner removed the first (2026-09-21) and then the second ("without the alliance
  // outline, the robot now just has a black outline. fix this"): a lit, shaded body has its own
  // edges, and a drawn line round it only ever existed to carry the alliance colour.

  // WHICH END IS THE FRONT. `bbFrontMarks` (`parts.ts`) is the geometry AND the design note —
  // read that header before changing anything here, including why it does not follow the
  // driver's REVERSED. The 2D sprite fills the identical three rectangles.
  for (const part of buildFrontMarks(spec, id)) group.add(part);

  // THE DECAL — a baked CanvasTexture on the deck (the `getSignTexture` technique), cached per
  // decal key × accent colour. `'none'` adds no node, matching a default-cosmetic build's node
  // set byte-for-byte. It sits a hair above the deck's own top face so it never z-fights it.
  if (cosm.decal !== 'none') {
    const deckL = spec.length; // the deck is the whole footprint (2026-09-21)
    const deckW = spec.width;
    const decalTex = getDecalTexture(cosm.decal, accent, deckL / deckW);
    const decalMat = new THREE.MeshStandardMaterial({ map: decalTex, roughness: 0.7, transparent: true });
    const decal = new THREE.Mesh(new THREE.BoxGeometry(deckL, deckW, 0.02), decalMat);
    decal.name = `robot:${id}:decal`;
    decal.position.set(0, 0, BB_DECK_Z + 0.02);
    group.add(decal);
  }

  // THE TWO ROBOT SIGNS (R401: "Minimum of two ROBOT SIGNS per ROBOT … on opposite or adjacent
  // surfaces"). Both side plates is the OPPOSITE case, and it is the one that reads from either
  // side of the FIELD — the header above has the rule text and every dimension's citation. ONE
  // texture and ONE geometry serve both; only the orientation differs, and neither is mirrored.
  const signTex = getSignTexture(bbRobotSignText(spec), alliance);
  const signGeo = new THREE.PlaneGeometry(BB_SIGN_W, BB_SIGN_H);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 });
  // THE PLATE — a frame round the sign placard (`docs/cosmetics-plan.md` §3.4). `'classic'` is no
  // frame, so it adds no node either, same rule as the decal. The placard's own fill/number stay
  // untouched — only a frame sits a hair further out, in front of it.
  const plateGeo = cosm.plate !== 'classic' ? buildSignPlateGeometry(cosm.plate) : null;
  const plateMat = plateGeo ? solidMat(cosm.plate === 'bold' ? accent : PLATE_SILVER, 0.5, cosm.plate === 'bold' ? 0.3 : 0.6) : null;
  for (const [side, where] of [[1, 'left'], [-1, 'right']] as const) {
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.name = `robot:${id}:sign:${where}`;
    // R401.D — supported by the structure of the ROBOT: it sits ON the side plate, a hair proud
    // of it, and centred on the drivetrain band. `BB_PLATE_H` is 4.6 in, so a 2.75-in plate has
    // clearance top and bottom on every chassis this builder can make.
    sign.position.set(0, side * (spec.width / 2 + 0.05), BB_PLATE_H * 0.5);
    sign.quaternion.copy(bbRobotSignOrientation(side));
    group.add(sign);
    if (plateGeo && plateMat) {
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.name = `robot:${id}:plate:${where}`;
      plate.position.set(0, side * (spec.width / 2 + 0.05 + 0.02), BB_PLATE_H * 0.5);
      plate.quaternion.copy(bbRobotSignOrientation(side));
      group.add(plate);
    }
  }

  const intake = buildIntake(spec, accent);
  for (const n of intake.nodes) group.add(n);
  group.userData.intakeRollers = intake.rollers;
  group.userData.sideRollers = intake.sideRollers;
  group.userData.rampPivots = intake.rampPivots;

  const heads: THREE.Group[] = [];
  const pitches: THREE.Group[] = [];
  if (bbIsTurreted(launcher)) {
    const t0 = buildTurret(spec, launcher.mount, 0);
    group.add(t0);
    heads.push(t0.userData.head as THREE.Group);
    pitches.push(t0.userData.pitch as THREE.Group);
    if (launcher.kind === 'twinturret' && launcher.mount2) {
      // ⚠️ `1`, AND IT IS NOT A LABEL. Turret 1 is the NECTAR exit (`bbTurretFor`), and a NECTAR
      // is 3.6 in where a POLLEN is 2.8 — so this head is built to a different dimension set and
      // releases from a different muzzle, which is the sim's own answer too.
      const t1 = buildTurret(spec, launcher.mount2, 1);
      group.add(t1);
      heads.push(t1.userData.head as THREE.Group);
      pitches.push(t1.userData.pitch as THREE.Group);
    }
  } else if (launcher.kind === 'dumper') {
    const d = buildDumper(spec, launcher);
    group.add(d);
    group.userData.dumpArm = d.userData.dumpArm;
  }
  // A BUILT ROBOT'S HOOD STARTS WHERE A SPAWNED ONE DOES — `BB_TURRET_PITCH_REST`, an elevation the
  // aim solve actually produces. The match's `sync` overwrites it on its first frame; the builder
  // preview and the saved-robot thumbnails never sync, so this is the pose they show.
  for (const p of pitches) p.rotation.y = -BB_TURRET_PITCH_REST;
  group.userData.turretHeads = heads;
  group.userData.turretPitches = pitches;
  group.userData.launcher = launcher;

  if (lift) {
    const tube = buildBoxTube(spec, lift.mount, id);
    group.add(tube.node);
    group.userData.tubeStages = tube.stages;
    group.userData.tube = tube.rig;
  }

  return group;
}

/**
 * THE FRONT/BACK LANGUAGE, 3D half — three nodes, the same three rectangles the 2D sprite fills.
 *
 * ⚠️ **IT REPLACES THE `robot:<id>:nose` BOX, AND THE BOX WAS THE BUG** (owner, 2026-09-22: "make
 * it clearer fundamentally which side is front and which is back in game. This is especially
 * confusing in a symmetric robot in 3D"). That was 0.7 in long and 22% of the width, sitting on
 * the front cross member — behind the intake from the one angle you would look for it, and about
 * four screen pixels from the match camera. A cue you have to already know about is not a cue.
 *
 *  • `front:bar` — the full-width light bar, its outer face FLUSH with the front rail and
 *    standing `BB_END_BAR_H` above the deck, so it breaks the chassis silhouette from a chase
 *    camera and is still a bright full-width line from directly overhead. It is `emissive` at full strength: the field is lit for aluminium
 *    and a matte white bar goes grey in the hive's shadow, which is exactly where a driver is
 *    when they most need to know which way they are pointing.
 *  • `front:arrow` — the deck chevron, extruded a hair so it takes an edge highlight rather than
 *    reading as a decal sticker.
 *  • `rear:bar` — a plain rail in the chassis' own structural dark. It carries NO stripes: the
 *    amber-and-black hazard bar the first pass gave it was the owner's second report of the day
 *    ("what is this ugly ass yellow and black beams rendered in 3D? It is awful and does not fit
 *    FTC"), and `bbFrontMarks`' header has why it went rather than being toned down.
 *
 * ⚠️ NONE OF THE THREE IS A COLLIDER AND NONE GROWS THE FOOTPRINT. The bars sit INSIDE the
 * chassis box in x (`bbFrontMarks` puts them within the rail) and only stand above the deck,
 * which is the same bargain `buildEndPlates` made — the RENDER lane asserts it for both.
 */
export function buildFrontMarks(spec: RobotSpec, id: number): THREE.Object3D[] {
  const m = bbFrontMarks(spec);
  const out: THREE.Object3D[] = [];
  const barZ = BB_DECK_Z + BB_END_BAR_H / 2;

  // an end bar gives way where a Box Tube's pivot stands on the same rail (`bbFrontMarks`)
  const barKey = (b: { gap: { y0: number; y1: number } | null }): string =>
    b.gap ? `|gap${b.gap.y0.toFixed(3)}:${b.gap.y1.toFixed(3)}` : '';
  const barParts = (b: typeof m.front): THREE.BufferGeometry[] =>
    bbEndBarSegments(b).map((sg) => boxAt(b.x1 - b.x0, sg.y1 - sg.y0, BB_END_BAR_H, (b.x0 + b.x1) / 2, (sg.y0 + sg.y1) / 2, 0));
  const front = cast(
    new THREE.Mesh(
      framePart(`front:bar|${m.front.x0.toFixed(3)}|${m.front.halfY.toFixed(3)}${barKey(m.front)}`, () => barParts(m.front)),
      frontBarMat(),
    ),
  );
  front.name = `robot:${id}:front:bar`;
  front.position.set(0, 0, barZ);
  out.push(front);

  const arrow = cast(
    new THREE.Mesh(
      framePart(`front:arrow|${m.arrow.apex.toFixed(3)}|${m.arrow.base.toFixed(3)}|${m.arrow.half.toFixed(3)}`, () => {
        const shape = new THREE.Shape();
        shape.moveTo(m.arrow.apex, 0);
        shape.lineTo(m.arrow.base, m.arrow.half);
        shape.lineTo(m.arrow.base, -m.arrow.half);
        shape.closePath();
        return [new THREE.ExtrudeGeometry(shape, { depth: BB_FRONT_ARROW_T, bevelEnabled: false })];
      }),
      solidMat(BB_FRONT_INK, 0.45, 0.05),
    ),
  );
  arrow.name = `robot:${id}:front:arrow`;
  arrow.position.set(0, 0, BB_DECK_Z + 0.02);
  out.push(arrow);

  const rear = cast(
    new THREE.Mesh(
      framePart(`rear:bar|${m.rear.x1.toFixed(3)}|${m.rear.halfY.toFixed(3)}${barKey(m.rear)}`, () => barParts(m.rear)),
      solidMat(BB_REAR_INK, 0.75, 0.05),
    ),
  );
  rear.name = `robot:${id}:rear:bar`;
  rear.position.set(0, 0, barZ);
  out.push(rear);

  return out;
}

/**
 * THE BOX TUBE — a vertical two-stage box-tube slide on a pivot at the frame rail, with a wrist
 * and a claw on top. `config.ts`'s "THE BOX TUBE" block is the design and the list of what the
 * old telescoping arm got wrong; this builds its boxes (`bbBoxTubeStowedBoxes`) and nothing the
 * block does not name, so the 2D sprite, this mesh and the collider are one geometry.
 *
 * NODES (all in the tower frame: x = u outward, y = v, z up, origin on the pivot axle):
 *   tube            the base, fixed: pivot plates, axle, pivot pulley + belt, string spool
 *   tube:pitch      the lean, about the axle (y); carries the three tubes
 *   tube:s0…s2      the tubes; s1 and s2 slide along z by one stage extension each
 *   tube:level      on top of s2, un-leans, so the wrist stays level whatever the lean
 *   tube:yaw        the claw's bearing about the mast axis
 *   tube:swing      the wrist hinge; the claw hangs down (0) or swings level (π/2)
 *   tube:jaw:l/r    the two jaws, opening about the palm
 *   tube:claw       an empty marker at the claw centre — what the RENDER lane measures
 */
export function buildBoxTube(
  spec: RobotSpec,
  mount: BbMountPos,
  id: number,
): { node: THREE.Group; stages: THREE.Object3D[]; rig: BbTubeRig } {
  const place = bbPlacePointLocal(spec);
  const frame = bbBoxTubeFrame(spec, mount, place);
  const stageTable = bbBoxTubeStages(frame.placeDist);
  const L = stageTable.sectionLen;
  const node = new THREE.Group();
  node.name = `robot:${id}:tube`;
  node.position.set(frame.outer.x, frame.outer.y, BB_BOX_TUBE_Z);
  node.rotation.z = Math.atan2(frame.uy, frame.ux);
  const baseYaw = node.rotation.z;

  // ── THE BASE: the boxes `bbBoxTubeStowedBoxes` names, plus the round parts inside them ──────
  const boxes = bbBoxTubeStowedBoxes(frame, stageTable);
  const plateMat = solidMat(ALU_DK, 0.55, 0.35);
  const darkMat = solidMat(MOTOR, 0.6, 0.2);
  const base = cast(
    new THREE.Mesh(
      framePart(`tube:base|${L.toFixed(3)}`, () => {
        const parts: THREE.BufferGeometry[] = [];
        for (const b of boxes) {
          if (b.what !== 'plate') continue;
          parts.push(boxAt(b.u1 - b.u0, b.v1 - b.v0, b.z1 - b.z0, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2, (b.z0 + b.z1) / 2));
        }
        // the axle, through both plates and the base tube's foot
        const vOut = BB_BOX_TUBE_SECTIONS[0] / 2 + BB_BOX_TUBE_PLATE_GAP + BB_BOX_TUBE_PLATE_T + BB_BOX_TUBE_DRUM_T;
        const axle = new THREE.CylinderGeometry(0.16, 0.16, vOut * 2, 12);
        parts.push(axle);
        return parts;
      }),
      plateMat,
    ),
  );
  base.name = `robot:${id}:tube:pivot`;
  node.add(base);
  const drums = cast(
    new THREE.Mesh(
      framePart(`tube:drums`, () => {
        const parts: THREE.BufferGeometry[] = [];
        const v0 = BB_BOX_TUBE_SECTIONS[0] / 2 + BB_BOX_TUBE_PLATE_GAP + BB_BOX_TUBE_PLATE_T;
        const t = BB_BOX_TUBE_DRUM_T;
        const r = BB_BOX_TUBE_DRUM_R;
        // +v: the PIVOT PULLEY, and its belt running down into the deck to the motor under it
        const pulley = new THREE.CylinderGeometry(r, r, t, 20);
        pulley.translate(0, v0 + t / 2, 0);
        parts.push(pulley);
        const deck = BB_DECK_Z - BB_BOX_TUBE_Z;
        for (const su of [1, -1] as const) {
          const len = -deck + 0.05;
          parts.push(boxAt(0.06, t * 0.8, len, su * (r - 0.03), v0 + t / 2, deck + len / 2 - 0.05));
        }
        // −v: the STRING SPOOL — a drum between two flanges
        const drum = new THREE.CylinderGeometry(r * 0.6, r * 0.6, t, 16);
        drum.translate(0, -(v0 + t / 2), 0);
        parts.push(drum);
        for (const dv of [0.02, t - 0.02]) {
          const flange = new THREE.CylinderGeometry(r, r, 0.04, 20);
          flange.translate(0, -(v0 + dv), 0);
          parts.push(flange);
        }
        return parts;
      }),
      darkMat,
    ),
  );
  drums.name = `robot:${id}:tube:drive`;
  node.add(drums);

  // ── THE LEAN, AND THE THREE TUBES ON IT ──────────────────────────────────────────────────────
  const pitch = new THREE.Group();
  pitch.name = `robot:${id}:tube:pitch`;
  node.add(pitch);
  const tubeMat = solidMat(ALU, 0.4, 0.45);
  const collarMat = solidMat(MOTOR, 0.7, 0.05);
  const stages: THREE.Object3D[] = [];
  let top: THREE.Object3D = pitch;
  for (let i = 0; i < BB_BOX_TUBE_SECTIONS.length; i++) {
    const w = BB_BOX_TUBE_SECTIONS[i];
    // each tube spans [−BASE_BELOW, L − BASE_BELOW] along its own z, so a stage offset by `d` has
    // its top face at `L − BASE_BELOW + d`
    const geo = framePart(`tube:${w}|${L.toFixed(3)}`, () => {
      const wall = BB_BOX_TUBE_WALL;
      const zc = L / 2 - BB_BOX_TUBE_BASE_BELOW;
      const parts: THREE.BufferGeometry[] = [];
      // HOLLOW, as four walls, so the mouth reads as a tube and the next stage visibly slides in it
      for (const s of [1, -1] as const) {
        parts.push(boxAt(w, wall, L, 0, (s * (w - wall)) / 2, zc));
        parts.push(boxAt(wall, w - wall * 2, L, (s * (w - wall)) / 2, 0, zc));
      }
      return parts;
    });
    const mesh = cast(new THREE.Mesh(geo, tubeMat));
    mesh.name = `robot:${id}:tube:s${i}`;
    // NESTED: each stage hangs off the one it slides in, so a stage's own `position.z` is its
    // extension out of its parent and the tip rides on the last one
    (i === 0 ? pitch : stages[i - 1]).add(mesh);
    stages.push(mesh);
    // the BEARING BLOCK at the mouth of every tube that another slides in (not the last)
    if (i < BB_BOX_TUBE_SECTIONS.length - 1) {
      const collar = cast(
        new THREE.Mesh(
          framePart(`tube:collar:${w}`, () => {
            const h = 0.35;
            const parts: THREE.BufferGeometry[] = [];
            const o = w + 2 * BB_BOX_TUBE_COLLAR;
            const inner = BB_BOX_TUBE_SECTIONS[i + 1];
            const zc = L - BB_BOX_TUBE_BASE_BELOW - h / 2;
            for (const s of [1, -1] as const) {
              parts.push(boxAt(o, (o - inner) / 2, h, 0, (s * (o + inner)) / 4, zc));
              parts.push(boxAt((o - inner) / 2, inner, h, (s * (o + inner)) / 4, 0, zc));
            }
            return parts;
          }),
          collarMat,
        ),
      );
      collar.name = `robot:${id}:tube:s${i}:block`;
      mesh.add(collar);
    }
    top = mesh;
  }

  // ── THE WRIST AND THE CLAW, on top of the last stage ────────────────────────────────────────
  const tip = new THREE.Group();
  tip.name = `robot:${id}:tube:tip`;
  tip.position.z = L - BB_BOX_TUBE_BASE_BELOW;
  top.add(tip);
  const level = new THREE.Group();
  level.name = `robot:${id}:tube:level`;
  tip.add(level);
  const wrist = cast(
    new THREE.Mesh(
      framePart('tube:wrist', () => {
        const w = BB_BOX_TUBE_WRIST_HALF * 2;
        return [boxAt(w, w * 0.8, BB_BOX_TUBE_WRIST_TOP, 0, 0, BB_BOX_TUBE_WRIST_TOP / 2)];
      }),
      darkMat,
    ),
  );
  wrist.name = `robot:${id}:tube:wrist`;
  level.add(wrist);
  const yaw = new THREE.Group();
  yaw.name = `robot:${id}:tube:yaw`;
  level.add(yaw);
  // the YOKE the wrist servo turns: a top bar out to the hinge and two cheeks either side of it
  const yoke = cast(
    new THREE.Mesh(
      framePart('tube:yoke', () => {
        const half = BB_BOX_TUBE_ARM_W / 2 + 0.06;
        const x0 = BB_BOX_TUBE_WRIST_HALF - 0.25;
        const x1 = BB_BOX_TUBE_YOKE_OUT;
        const parts = [boxAt(x1 - x0, half * 2 + 0.12, 0.1, (x0 + x1) / 2, 0, BB_BOX_TUBE_WRIST_TOP - 0.05)];
        // (the whole yoke stays inside `BB_BOX_TUBE_CLAW_HALF` across, which the collider reads)
        for (const sg of [1, -1] as const) {
          parts.push(boxAt(0.3, 0.06, BB_BOX_TUBE_WRIST_TOP - BB_BOX_TUBE_WRIST_H + 0.12, BB_BOX_TUBE_WRIST_E, sg * (half + 0.03), (BB_BOX_TUBE_WRIST_TOP + BB_BOX_TUBE_WRIST_H - 0.12) / 2));
        }
        return parts;
      }),
      plateMat,
    ),
  );
  yoke.name = `robot:${id}:tube:yoke`;
  yaw.add(yoke);
  const swing = new THREE.Group();
  swing.name = `robot:${id}:tube:swing`;
  swing.position.set(BB_BOX_TUBE_WRIST_E, 0, BB_BOX_TUBE_WRIST_H);
  yaw.add(swing);
  const ell = BB_BOX_TUBE_CLAW_REACH - BB_BOX_TUBE_WRIST_E;
  const palmAt = ell - BB_BOX_TUBE_PALM_BACK;
  const arm = cast(
    new THREE.Mesh(
      framePart('tube:arm', () => {
        const t = BB_BOX_TUBE_ARM_T;
        const w = BB_BOX_TUBE_ARM_W;
        const parts: THREE.BufferGeometry[] = [];
        // the arm, hanging along −z from the hinge; the hinge boss; the palm across its end
        parts.push(boxAt(t, w, palmAt + t / 2, 0, 0, -(palmAt - t / 2) / 2));
        const boss = new THREE.CylinderGeometry(0.1, 0.1, w + 0.24, 12);
        parts.push(boss);
        parts.push(boxAt(t, (BB_BOX_TUBE_JAW_ROOT + BB_BOX_TUBE_JAW_T) * 2, BB_BOX_TUBE_JAW_T * 1.5, 0, 0, -palmAt));
        return parts;
      }),
      plateMat,
    ),
  );
  arm.name = `robot:${id}:tube:arm`;
  swing.add(arm);
  const jaws: THREE.Group[] = [];
  for (const [sg, tag] of [[1, 'l'], [-1, 'r']] as const) {
    const g = new THREE.Group();
    g.name = `robot:${id}:tube:jaw:${tag}`;
    g.position.set(0, sg * BB_BOX_TUBE_JAW_ROOT, -palmAt);
    const jaw = cast(
      new THREE.Mesh(
        framePart(`tube:jaw:${tag}`, () => {
          // a finger with a short hook at its tip, turned INWARD on both jaws, so the pair reads as
          // a claw (built per side rather than mirrored: a negative scale turns a mesh inside out)
          const l = BB_BOX_TUBE_JAW_L;
          return [
            boxAt(BB_BOX_TUBE_JAW_H, BB_BOX_TUBE_JAW_T, l, 0, 0, -l / 2),
            boxAt(BB_BOX_TUBE_JAW_H, 0.28, BB_BOX_TUBE_JAW_T, 0, -sg * 0.1, -l + BB_BOX_TUBE_JAW_T / 2),
          ];
        }),
        darkMat,
      ),
    );
    g.add(jaw);
    swing.add(g);
    jaws.push(g);
  }
  const claw = new THREE.Object3D();
  claw.name = `robot:${id}:tube:claw`;
  claw.position.set(0, 0, -ell);
  swing.add(claw);
  // STOWED as built: the claw hangs along the frame's stow side, which is what the builder preview
  // shows (it never syncs) and what the first sync frame starts from
  const stowPsi = Math.atan2(frame.sy, frame.sx);
  yaw.rotation.z = stowPsi - baseYaw;

  return {
    node,
    stages,
    rig: {
      frame,
      stages: stageTable,
      baseYaw,
      pitch,
      level,
      yaw,
      swing,
      jaws,
      stowPsi,
    },
  };
}

/** what `sync` needs to pose one Box Tube. */
export interface BbTubeRig {
  frame: BbBoxTubeFrame;
  stages: ReturnType<typeof bbBoxTubeStages>;
  /** the tower frame's own yaw in the robot frame (the node's rotation) */
  baseYaw: number;
  pitch: THREE.Group;
  level: THREE.Group;
  yaw: THREE.Group;
  swing: THREE.Group;
  jaws: THREE.Group[];
  /** the folded claw's bearing, robot frame */
  stowPsi: number;
}

/** pose one Box Tube at joint values `j` (`bbBoxTubeJoints`). Exported for the RENDER lane, which
 * measures the drawn claw against the flower through exactly this. */
export function poseBoxTube(group: THREE.Group, j: { lean: number; ext: number; psi: number; swing: number; jaw: number }): void {
  const rig = group.userData.tube as BbTubeRig | undefined;
  const stages = group.userData.tubeStages as THREE.Object3D[] | undefined;
  if (rig && stages) poseBoxTubeRig(rig, stages, j);
}

/** the same, for a tube built on its own (`buildBoxTube`) */
export function poseBoxTubeRig(
  rig: BbTubeRig,
  stages: THREE.Object3D[],
  j: { lean: number; ext: number; psi: number; swing: number; jaw: number },
): void {
  rig.pitch.rotation.y = Math.PI / 2 - j.lean;
  rig.level.rotation.y = -(Math.PI / 2 - j.lean);
  // nested stages: each one's own offset is one stage extension out of its parent
  for (let i = 1; i < stages.length; i++) stages[i].position.z = j.ext;
  rig.yaw.rotation.z = j.psi - rig.baseYaw;
  rig.swing.rotation.y = -j.swing;
  rig.jaws[0].rotation.x = j.jaw;
  rig.jaws[1].rotation.x = -j.jaw;
}

/** THE VISUAL HEIGHT OF THE DRIVETRAIN — where the DECK is, for anything that has to reason
 * about it without importing three.js. `BB_DECK_Z` is this number. */
export const BB_DRIVETRAIN_H = BB_PLATE_H;
/**
 * ⚠️ `BB_SHOOTER_MUZZLE_Z` IS RETIRED, AND SO IS THE IDEA BEHIND IT. It exported `BB_LAUNCH_Z0`
 * as "where the muzzle sits", which was true only while the muzzle was a CONSTANT. The release
 * follows the hood now (owner, 2026-09-19), so the muzzle is a FUNCTION of elevation and the one
 * that answers it is `bbMuzzleLocal(pitch)` in `robot.ts` — read by the sim, by the shot-path
 * predictor and by the `bb-turret-exit` node this file places. A second export here would be the
 * second number that started all of this.
 */

interface RobotEntry {
  group: THREE.Group;
  key: string;
  /** how far the Box Tube's deploy has run, 0..1 — LINEAR in time; every joint's own smoothstep
   *  is in `bbBoxTubePhases`. On the ENTRY and not on `userData`, so a `bbSpecKey` rebuild (which
   *  changes the tower) resets it instead of easing from a stale fraction. */
  tubeEase: number;
  /** the POSE the deploy runs toward (`bbBoxTubePose`), solved against the flower
   *  `bbFlowerInReach` names and HELD while it names none, so a retraction runs back down the
   *  path it came up. */
  tubeLean: number;
  tubeExt: number;
  tubePsi: number;
  tubeSwing: number;
}

export interface BbRobots {
  group: THREE.Group;
  /**
   * THE TIER'S WHEEL TESSELLATION, live. A PROPERTY, the same shape `BbElements.rollingSpin` is
   * and for the same reason — `renderScene.applyQuality` writes both on every settings change,
   * and the scene must not have to be torn down to answer one.
   *
   * It is the one graphics setting a ROBOT cannot apply in place (the wheel's geometry is baked
   * at build time), so `sync` folds it into the entry's rebuild key beside `bbSpecKey` and the
   * group is rebuilt on the next frame after a change. That is cheap here and nowhere near the
   * field's own mesh-detail problem: four small groups, not a 6 MB GLB refetch.
   */
  wheelDetail: BbWheelDetail;
  /** `effects` row: `minimal` stops the wheels turning (see the roll in `sync`). */
  wheelSpin: boolean;
  dispose(): void;
}

/** intake roller speed (rad/s at the drawn radius) while it is running. Cosmetic. */
/** ⚠️ THE SIM'S OWN DRAW-IN, AT THE FLAP TIP — not a typed rate. A roller drawn at a surface
 *  speed other than the one the sim walks an element in at is a picture of a different
 *  machine, and at the old 26 rad/s x a 1.0-in barrel it was running at exactly HALF
 *  `BB_INTAKE_DRAW_IN`. Derived, so it cannot fall out of step again. */
const BB_ROLLER_SPIN = BB_INTAKE_DRAW_IN / BB_ROLLER_FLAP_R;

export function buildBiobuzzRobots(): BbRobots {
  const group = new THREE.Group();
  group.name = 'bb-robots';
  const entries = new Map<number, RobotEntry>();
  let lastTime = 0;
  // the live quality dials, overwritten by `renderScene.applyQuality`; these defaults are what a
  // scene that never applies any settings at all (the smoke lanes) gets
  let wheelDetail: BbWheelDetail = 'high';
  let wheelSpin = true;

  function sync(world: World): void {
    const seen = new Set<number>();
    // the world clock, not a wall clock: this module has no business owning one, and a replay
    // scrub that jumps backwards must not spin a roller a thousand turns to catch up
    const dt = Math.max(0, Math.min(0.2, world.time - lastTime));
    lastTime = world.time;
    for (const r of world.robots) {
      seen.add(r.id);
      // ⚠️ `bbSpecKey` PLUS THE WHEEL TIER, AND THE TIER IS NOT ADDED TO `bbSpecKey`. That key is
      // the BUILD's geometry identity and it is read outside this chunk, by the main bundle's
      // thumbnail cache (`specKey.ts`'s own header) — folding a per-device graphics setting into
      // it would make two machines disagree about whether two saved robots are the same robot.
      // This is a local rebuild key: the same spec at a different tessellation is the same build.
      const key = `${bbSpecKey(r.spec)}|${wheelDetail}`;
      let entry = entries.get(r.id);
      if (!entry || entry.key !== key) {
        if (entry) {
          group.remove(entry.group);
          disposeRobotGroup(entry.group);
        }
        const g = buildRobotGroup(r.spec, r.id, r.alliance, wheelDetail);
        entry = { group: g, key, tubeEase: 0, tubeLean: Math.PI / 2, tubeExt: 0, tubePsi: 0, tubeSwing: 0 };
        entries.set(r.id, entry);
        group.add(g);
      }
      entry.group.position.set(r.pos.x, r.pos.y, r.z ?? 0);
      entry.group.rotation.set(0, 0, r.heading);

      // THE INTAKE SPINS WHEN IT IS COLLECTING. Derived from the WORLD alone (the 3D sync never
      // sees a command): a robot on auto-intake with room in its hopper is running, and so is one
      // that took an element in the last fraction of a second, which is the driver-held case.
      const rollers = entry.group.userData.intakeRollers as BbRoller[] | undefined;
      if (rollers && rollers.length > 0) {
        // ...and the robots are ENABLED — auto-intake is a standing assist, so without the gate the
        // roller kept turning through the auto→teleop transition while the sim captured nothing.
        const running =
          robotsEnabled(world) &&
          (r.autoIntake || world.time - r.lastIntakeAt < 0.4) &&
          r.hopper.length < bbHopperCap(r.spec);
        for (const roller of rollers) {
          if (running) roller.phase += BB_ROLLER_SPIN * dt;
          roller.hub.rotation.y = -roller.phase;
          // ⚠️ THE FLAPS ARE POSED EVERY FRAME, RUNNING OR NOT. Pass-under is a statement about
          // the drawn envelope, not about the animation: a stopped roller whose flaps hang into
          // the collider's open pocket blocks it just as visibly as a spinning one.
          for (let k = 0; k < roller.flaps.length; k++) {
            const a = roller.phase + (k * Math.PI * 2) / roller.flaps.length;
            const fold = flapFold(a);
            roller.flaps[k].position.set(Math.cos(a) * BB_ROLLER_HUB_R, 0, Math.sin(a) * BB_ROLLER_HUB_R);
            // the flap TRAILS the hub, so the fold is subtracted from its own direction
            roller.flaps[k].rotation.y = -(a - fold);
          }
        }
      }

      // THE SIDE ROLLERS SPIN WHENEVER THE SWEEPER DOES — same gate, same clock — but the two
      // wheels of a pair turn OPPOSITE senses, drawing a POLLEN in from both faces rather than
      // fighting each other. No flap fold: a plain compliant wheel has nothing to yield.
      const sideRollers = entry.group.userData.sideRollers as BbSideRoller[] | undefined;
      if (sideRollers && sideRollers.length > 0) {
        const running =
          robotsEnabled(world) &&
          (r.autoIntake || world.time - r.lastIntakeAt < 0.4) &&
          r.hopper.length < bbHopperCap(r.spec);
        for (const sr of sideRollers) {
          if (running) sr.phase += BB_ROLLER_SPIN * dt * sr.sign;
          sr.mesh.rotation.z = sr.phase;
        }
      }

      // THE RAMP EASES BETWEEN FOLDED AND DEPLOYED OFF `bbRampAt` — the WORLD clock, exactly like
      // the roller and the Box Tube, so a replay scrub that jumps backwards does not unwind it.
      // An absent `bbRampAt` sends `t` straight to 1: the robot is drawn fully at its current pose
      // rather than mid-swing from a toggle that never happened this match.
      const rampPivots = entry.group.userData.rampPivots as THREE.Group[] | undefined;
      if (rampPivots && rampPivots.length > 0) {
        const t = Math.max(0, Math.min(1, (world.time - (r.bbRampAt ?? -Infinity)) / BB_RAMP_DEPLOY_S));
        const e = smoothstep01(t);
        const angle = r.bbRampOut ? BB_RAMP_DEPLOYED_ROT * e : BB_RAMP_DEPLOYED_ROT * (1 - e);
        for (const pivot of rampPivots) pivot.rotation.y = angle;
      }

      // THE DRIVETRAIN POSE. Both of these are state the sim already writes and the 3D view was
      // throwing away: a swerve's four pods each slew on their OWN imperfect steering loop
      // (`moduleAngles`, corner order [FL, FR, BL, BR]) and a butterfly's driver drops one of two
      // wheel sets mid-match (`butterflyTank`). Nothing is added to the sim to feed either one.
      const pods = entry.group.userData.swervePods as THREE.Group[] | undefined;
      if (pods) for (let i = 0; i < pods.length; i++) pods[i].rotation.z = r.moduleAngles[i] ?? 0;
      const sets = entry.group.userData.butterflySets as
        | { traction: BbLiftSet[]; roller: BbLiftSet[] }
        | undefined;
      if (sets && sets.traction.length > 0) {
        // ⚠️ EACH SET'S OWN GROUNDED HEIGHT, not one `BB_WHEEL_R` for both. The corner set is a
        // 104 mm mecanum and the inboard set a 96 mm Hogback, so a shared constant would bury
        // whichever one it was not measured from 0.157 in in the tiles.
        for (const m of sets.traction) m.node.position.z = m.z + (r.butterflyTank ? 0 : BB_BUTTERFLY_LIFT);
        for (const m of sets.roller) m.node.position.z = m.z + (r.butterflyTank ? BB_BUTTERFLY_LIFT : 0);
      }

      /**
       * THE WHEELS TURN, AND THEY TURN AT THE SPEED THE ROBOT IS ACTUALLY DOING.
       *
       * ω = v/R off `r.vel` projected on the heading, integrated on the same clamped WORLD clock
       * everything else in this sync uses — so a replay scrub that jumps backwards does not
       * unwind a wheel a thousand turns, exactly as for the intake roller. The rolling radius
       * comes from the part each wheel actually is (`BbSpinWheel.r`), which is the third place
       * the 104 / 96 / 72 mm distinction has to be honoured rather than assumed.
       *
       * A mecanum's rollers are geometry ON this node, so they sweep with it and a LEFT-slant
       * wheel's rollers sweep the left-slant way for free. That is the part a painted stripe
       * could never have got right at all: a texture on a spinning cylinder keeps its slant
       * relative to the SCREEN, not to the hardware.
       *
       * `wheelSpin` is the `effects` setting's own row ("minimal — … no wheel rotation"), which
       * until now nothing implemented; `renderScene.applyQuality` sets it.
       */
      const spinning = entry.group.userData.spinWheels as BbSpinWheel[] | undefined;
      if (spinning && spinning.length > 0) {
        if (wheelSpin) {
          const v = r.vel.x * Math.cos(r.heading) + r.vel.y * Math.sin(r.heading);
          for (const w of spinning) w.node.rotation.y -= (v / w.r) * dt;
        }
      }

      // THE BOX TUBE DEPLOYS OVER THE FLOWER WHEN ONE IS IN REACH. `bbFlowerInReach` is the SIM's
      // own predicate — the same one the sprite's placement marker and the HUD chip read — so the
      // three cues cannot disagree about whether this robot can place, and the flower it NAMES is
      // the one the claw goes over. The ease is the renderer's (a rate is a function of frame
      // history) and runs off the same clamped WORLD clock the roller does, so a replay scrub that
      // jumps backwards does not unwind it.
      const rig = entry.group.userData.tube as BbTubeRig | undefined;
      if (rig) {
        const flower = bbFlowerInReach(world, r);
        const want = flower !== null ? 1 : 0;
        if (flower !== null) {
          // the bore and the flower's own normal, brought into the robot's frame: the group already
          // carries `heading` and `r.z`, so the pose is solved in the frame the nodes live in
          const f = BB_FLOWERS[flower];
          const n = FLOWER_MOUTH[f.wall];
          const c = Math.cos(-r.heading);
          const s = Math.sin(-r.heading);
          const dx = f.x - r.pos.x;
          const dy = f.y - r.pos.y;
          const pose = bbBoxTubePose(
            rig.frame,
            rig.stages,
            { x: dx * c - dy * s, y: dx * s + dy * c },
            { x: n.x * c - n.y * s, y: n.x * s + n.y * c },
            r.z ?? 0,
          );
          // STOWED, the target is taken whole (nothing is drawn out of place yet); once the arm is
          // out it SLEWS, so a change of target flower sweeps instead of snapping
          if (entry.tubeEase <= 0) {
            entry.tubeLean = pose.lean;
            entry.tubeExt = pose.ext;
            entry.tubePsi = pose.psi;
            entry.tubeSwing = pose.psiSwing;
          } else {
            const slew = BB_BOX_TUBE_SLEW * dt;
            entry.tubeLean += clampAbs(pose.lean - entry.tubeLean, slew);
            entry.tubeExt += clampAbs(pose.ext - entry.tubeExt, BB_BOX_TUBE_EXT_SLEW * dt);
            entry.tubePsi += clampAbs(wrapPi(pose.psi - entry.tubePsi), slew);
            entry.tubeSwing += clampAbs(wrapPi(pose.psiSwing - entry.tubeSwing), slew);
          }
        }
        const step = BB_BOX_TUBE_EXTEND_S > 0 ? dt / BB_BOX_TUBE_EXTEND_S : 1;
        entry.tubeEase =
          want > entry.tubeEase
            ? Math.min(want, entry.tubeEase + step)
            : Math.max(want, entry.tubeEase - step / BB_BOX_TUBE_RETRACT_F);
        poseBoxTube(
          entry.group,
          bbBoxTubeJoints(
            rig.frame,
            { lean: entry.tubeLean, ext: entry.tubeExt, psi: entry.tubePsi, psiSwing: entry.tubeSwing },
            entry.tubeEase,
          ),
        );
      }

      const heads = entry.group.userData.turretHeads as THREE.Group[] | undefined;
      const pitches = entry.group.userData.turretPitches as THREE.Group[] | undefined;
      const launcher = entry.group.userData.launcher as BbLauncherSpec | undefined;
      if (heads && heads.length > 0 && pitches && launcher) {
        // the turret's WORLD yaw is independent of the chassis (`turretHeading`); this group is
        // a child of the chassis group, which already carries `r.heading`, so the child's own
        // rotation only needs the DIFFERENCE. ELEVATION is a separate node under it, because only
        // the HOOD elevates — the flywheel, the plates and everything bolted between them are on
        // the yaw node and do not move with pitch at all (owner item d, 2026-09-19).
        //
        // ⚠️ NOTHING HERE CHANGED WHEN THE ASSEMBLY DID, AND THAT IS THE TEST OF THE RESTRUCTURE.
        // Same two node names, same two rotations, same signs; what moved is where `bb-turret-
        // pitch` pivots (the AXLE) and what hangs off it (the hood and its arms).
        heads[0].rotation.z = r.turretHeading - r.heading;
        pitches[0].rotation.y = -(r.bbTurretPitch ?? 0);
        if (heads.length > 1) {
          heads[1].rotation.z = (r.bbTurret2Heading ?? r.turretHeading) - r.heading;
          pitches[1].rotation.y = -(r.bbTurret2Pitch ?? 0);
        }
      }

      // THE CATAPULT'S ARM — one node, one rotation, off sim state alone (`dumpThrowPhase`).
      const dumpArm = entry.group.userData.dumpArm as THREE.Group | undefined;
      if (dumpArm) dumpArm.rotation.y = -DUMP_THROW_ANGLE * dumpThrowPhase(world, r);
    }
    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        group.remove(entry.group);
        disposeRobotGroup(entry.group);
        entries.delete(id);
      }
    }
  }

  // exposed on the group so `renderScene.ts` can call it without a second export surface
  group.userData.sync = sync;

  return {
    group,
    // ACCESSORS over the two closure variables, so a write from `applyQuality` reaches `sync`
    // without the caller having to know it is a closure and without a second copy of the value
    get wheelDetail(): BbWheelDetail {
      return wheelDetail;
    },
    set wheelDetail(v: BbWheelDetail) {
      wheelDetail = v;
    },
    get wheelSpin(): boolean {
      return wheelSpin;
    },
    set wheelSpin(v: boolean) {
      wheelSpin = v;
    },
    /**
     * ⚠️ **FREE EVERY LIVE ROBOT GROUP THROUGH `disposeRobotGroup`, WHICH IS WHY THIS EXISTS.**
     *
     * It used to only `entries.clear()`, which left the scene's own teardown to reach these
     * meshes — and that teardown is a blanket `disposeObject3D` walk, which does not know about
     * `SHARED_GEO`/`SHARED_MAT` and would free the frame geometry, the roller texture and every
     * solid material the BUILDER PREVIEW and the next match are still holding. The module caches
     * outlive any one scene, so "the scene is going away, nothing needs them" is exactly the
     * assumption that is false here.
     */
    dispose(): void {
      for (const entry of entries.values()) {
        group.remove(entry.group);
        disposeRobotGroup(entry.group);
      }
      entries.clear();
    },
  };
}

/**
 * Free what ONE robot group owns, and nothing that is shared.
 *
 * The per-robot half is every mesh built inline in `buildRobotGroup` — the two
 * ROBOT SIGN planes and their one shared material (their TEXTURE is cached per team number and
 * alliance, is shared with every other robot carrying it, and is not touched), the turret ring,
 * axle, motor and feed chute. The Box Tube's sections, the shooter's belt and the swerve
 * pod's drive all come from `framePart` and are SHARED. Anything from `solidMat`,
 * `getRollerMat`, `wheelGeometry` or `framePart` is left alone: see
 * `SHARED_GEO`'s header. The SWERVE POD is entirely shared — its three merged geometries come
 * from `framePart` and its materials from `solidMat` — so a builder session dragging the
 * drivetrain picker back and forth frees the group and re-uses every buffer in it.
 */
export function disposeRobotGroup(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh>;
    const geo = mesh.geometry;
    if (geo && !SHARED_GEO.has(geo)) geo.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) if (!SHARED_MAT.has(m)) m.dispose();
  });
}

export function updateBiobuzzRobots(robots: BbRobots, world: World): void {
  (robots.group.userData.sync as (w: World) => void)(world);
}
