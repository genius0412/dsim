import * as THREE from 'three';
import type { Artifact, ArtifactColor, World } from '../../../types';
import { BB_HIVE_W, BB_NECTAR_R, BB_POLLEN_R } from '../config';
import { BB_BOX_SLOTS, BB_BOX_T, bbNectarBoxSlot } from '../nectarBox';
import { biobuzzPhysics } from '../state';
import type { ElementDetail, ElementShadows } from '../graphics/settings';
import { loadElementGeometries } from './renderElementsGlb';

/**
 * BIOBUZZ 3D SCENE — the 56 scoring elements, as two `InstancedMesh`es (Day 1,
 * `docs/biobuzz/plan-3d.md` §3.4, §4.2).
 *
 * GEOMETRY. Two per kind, and the cheap one is always built first: a `SphereGeometry` (~176
 * triangles) and, on `elementDetail: 'cad'`, the real perforated CAD solid fetched by
 * `renderElementsGlb.ts` (2,286 / 2,542 triangles, 26 bores). The sphere is what stands while
 * the fetch is in flight and what stands forever if it fails — nothing here awaits, so a scene
 * is never held up by 22 KB and an offline player gets the Day 1 picture rather than no balls.
 *
 * POSITIONING. `ground`/`flight` balls are posed at `(pos.x, pos.y, z + r)` — `z` is already the
 * height ABOVE the tile a resting ball's centre sits at (a resting ground ball reads `z === 0`
 * in `draw.ts`/`play.ts`, so its drawn centre has to be lifted by its own radius; a flight ball's
 * `z` is real altitude). `held` balls are inside a robot and hidden (scaled to zero). `stock`
 * NECTAR is drawn in its alliance's holding box (`nectarBox.ts`), one per slot, through these same
 * meshes: the box used to draw its own plain spheres, which a player on High saw as smooth, glossy
 * balls beside the perforated ones on the field (owner, 2026-11-04: "the nectar in the box should
 * match the graphics of the nectar in the field").
 *
 * `element` balls (parked in a HIVE cell or a FLOWER stack, `state.ts`'s `BallState`) already
 * carry a REAL, useful `pos`/`z` — but WHAT that z means depends on which solve wrote it, so
 * the height adjustment branches on `biobuzzPhysics(world)` and not on the ball's kind; the
 * comment inside `updateBiobuzzElements` has the two conventions and the two bugs. A HIVE cell
 * is the one case `park()` does NOT give a unique
 * position: every element parked in the same cell shares that cell's centre point and a single
 * fixed height (`CELL_MID_Z`, `play.ts`), because "a parked element is not solved and has no
 * position of its own; this is somewhere to point at" (that file's own comment). Rendered
 * verbatim, every pollen in a cell would sit inside every other one. So this file does the ONE
 * approximation the Day 1 brief calls out: it groups a hive's parked elements by their `slot`
 * and fans them out along local x (the cell's un-foreshortened width axis, `BB_HIVE_W`, which a
 * hive tilt does not move since the tilt rotates about world x) — a row, exactly like the 2D
 * renderer's `drawCellContents`, but done from the ball's own (shared) position rather than the
 * `BbHiveState.contents` array (this file never reads `world.biobuzz.hives`).
 *
 * Under `'3d'` every element in the cell already has its own SOLVED position from the tray's
 * Rapier body — there is nothing to fan. Adding the 2D row fan on top of an already-distinct
 * position was itself a bug: measured, it walked a drawn sphere up to ±3.00 in off the body it
 * was meant to mark (5 elements in a cell), drew two elements that physically sit at the same
 * local x 4.5 in apart, and at higher counts pushed the sphere past the floor plate's own edge
 * and through the side wall — read at a glance as "meshing with the hive". The actual small
 * (0.06–0.15 in) penetration into the tray floor is the CONTACT SOLVE's, not this file's — see
 * `sim3d/engineImpl.ts`/`predict.ts`'s `contact_natural_frequency`; this file poses at the body
 * exactly, and does not fudge the draw to hide a physics number.
 */

/** how many instances each kind's `InstancedMesh` is sized for — the Day 1 brief's number, well
 * above the manual's per-kind counts (40 pollen, 16 nectar total) so nothing is ever dropped. */
const CAP = 56;

const POLLEN_COLOR = 0xf2d14b; // matches `draw.ts`'s ELEMENT_FILL.yellow
/** the one BIOBUZZ blue (`draw.ts`'s `ELEMENT_FILL.blue`, owner bug 12 — see that header for why
 * it is NOT the CAD's `plastic#0000ff`); red still matches `draw.ts`'s own `#e2564d`. */
const NECTAR_COLORS: Record<'red' | 'blue', number> = { red: 0xe2564d, blue: 0x007be1 };

const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

function isNectar(color: ArtifactColor): color is 'red' | 'blue' {
  return color === 'red' || color === 'blue';
}

/** one ball's visual-only orientation state — see `rollSpin`. */
interface BbSpin {
  /** the accumulated orientation, seeded from the ball's own id so a field of fresh POLLEN does
   * not show 40 copies of the same face. */
  q: THREE.Quaternion;
  /** where this ball was DRAWN last frame. The roll is integrated from the displacement between
   * two drawn positions, which is what makes it right at any frame rate and under snapshot
   * interpolation alike; it is recorded for EVERY ball, including a held/stock/parked one, so
   * that a ball re-entering play does not roll through the gap it was away for. */
  x: number;
  y: number;
}

export interface BbElements {
  pollen: THREE.InstancedMesh;
  nectar: THREE.InstancedMesh;
  group: THREE.Group;
  /** the cheap geometry, always built, always kept — the fallback `setElementDetail` returns to
   * and the one a CAD load failure leaves in place. */
  sphereGeo: { pollen: THREE.BufferGeometry; nectar: THREE.BufferGeometry };
  /** the perforated CAD geometry, once `renderElementsGlb.ts` has it; `null` until then and
   * forever if the asset cannot be loaded. */
  cadGeo: { pollen: THREE.BufferGeometry; nectar: THREE.BufferGeometry } | null;
  /** what the player asked for. Kept separately from `cadGeo` because the answer to "should
   * these be perforated" has to survive the asset arriving LATER than the pick. */
  detail: ElementDetail;
  /** per-ball-id visual orientation + last drawn position, keyed by the ball's stable `id` and
   * not by its per-frame instance index (`ground`/`flight` reassign indices every frame as
   * balls come and go). Pruned of ids no longer on the field once a frame's bookkeeping is
   * done, so a long match does not grow this map without bound. */
  spin: Map<number, BbSpin>;
  /** the `world.tick` the last frame was drawn at — a REWIND (a replay scrub, a reconnect, a
   * server snapshot from before the client's prediction) moves every ball at once, and nothing
   * may spin on that frame. */
  lastTick: number;
  /**
   * BLOB SHADOWS — one flat disc per loose element, for `elementShadows: 'blob'`
   * (`docs/biobuzz/plan-3d.md` §4.4). It is a middle rung and not a consolation prize: the
   * thing a driver actually reads off an element's shadow is WHERE IT IS ON THE FLOOR (and,
   * for one in flight, how high), and a disc under it answers that for one instanced draw and
   * zero shadow-map work, where `'real'` costs 56 more casters in the sun's depth pass.
   */
  blobs: THREE.InstancedMesh;
  /** which of the three modes is live — read by `updateBiobuzzElements` so it only does the
   * blob bookkeeping when there are blobs. Set through `setElementShadows`, never directly. */
  shadowMode: ElementShadows;
  /** `effects: 'minimal'` turns the rolling spin off: it is a cosmetic integration per ball per
   * frame, and it is the first thing to go on a machine that is counting. */
  rollingSpin: boolean;
}

export function buildBiobuzzElements(detail: ElementDetail = 'sphere'): BbElements {
  const pollenGeo = new THREE.SphereGeometry(BB_POLLEN_R, 12, 8);
  const nectarGeo = new THREE.SphereGeometry(BB_NECTAR_R, 12, 8);
  // POLLEN/NECTAR MATERIAL (Phase 2 fidelity): a little roughness so the key light's specular
  // highlight reads as a physical bead rather than a flat-shaded disc; still bright at the
  // saturated hues `draw.ts`'s 2D `ELEMENT_FILL`/`POLLEN_FILL` use, so the two views agree.
  //
  // A SMALL EMISSIVE (2026-09-18 lighting pass): a scoring element is the one thing on the field
  // a driver must always be able to pick out at a glance, including when it is sitting in a
  // hive's own shadow or against the darker tile mat — `emissiveIntensity` this low (0.08–0.12)
  // does not read as "glowing", it reads as "never quite goes fully dark", which is the effect an
  // AO pass would otherwise fight (AO darkens exactly the crevices/contacts a resting element
  // sits in). Nectar's emissive stays a flat white at a lower intensity, since its actual hue is
  // set per-instance via `setColorAt` below and emissive is a per-MATERIAL (not per-instance)
  // property — a coloured emissive here would tint every nectar the same regardless of alliance.
  const pollenMat = new THREE.MeshStandardMaterial({
    color: POLLEN_COLOR,
    roughness: 0.55,
    metalness: 0.05,
    emissive: POLLEN_COLOR,
    emissiveIntensity: 0.12,
  });
  const nectarMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.05,
    emissive: 0xffffff,
    emissiveIntensity: 0.05,
  }); // per-instance colour below

  const pollen = new THREE.InstancedMesh(pollenGeo, pollenMat, CAP);
  const nectar = new THREE.InstancedMesh(nectarGeo, nectarMat, CAP);
  pollen.name = 'bb-pollen';
  nectar.name = 'bb-nectar';
  pollen.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nectar.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < CAP; i++) {
    pollen.setMatrixAt(i, HIDE);
    nectar.setMatrixAt(i, HIDE);
    nectar.setColorAt(i, new THREE.Color(NECTAR_COLORS.red));
  }
  // THE BLOB DISC. Unlit (`MeshBasicMaterial`) on purpose — a shadow that got brighter when the
  // sun moved would be the one object in the scene lit by the thing it is meant to be blocking.
  // `depthWrite: false` keeps it from z-fighting the tile plane it lies a sixteenth of an inch
  // above, and `renderOrder: -1` draws it before the elements so a ball never sorts behind its
  // own shadow.
  const blobGeo = new THREE.CircleGeometry(1, 16);
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, CAP * 2);
  blobs.name = 'bb-element-blobs';
  blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blobs.renderOrder = -1;
  blobs.visible = false;
  for (let i = 0; i < CAP * 2; i++) blobs.setMatrixAt(i, HIDE);

  /**
   * ⚠️ **FRUSTUM CULLING ON AN `InstancedMesh` FULL OF MOVING INSTANCES IS A DISAPPEARING-BALL
   * BUG, AND IT SHIPPED.** Three computes an `InstancedMesh`'s bounding sphere ONCE, lazily,
   * from whatever the instance matrices held at that moment, and never again — setting
   * `instanceMatrix.needsUpdate` does not invalidate it. Every hidden instance is
   * `makeScale(0,0,0)` at the origin, so the NECTAR mesh (16 real balls, all of them off-field
   * `stock` at the start of a match) got a bounding sphere at the centre of the field and was
   * then culled outright by any camera aimed away from it. MEASURED on the scene-preview page:
   * a NECTAR dropped on the tiles at (15, −40) cast a shadow and drew NOTHING — the shadow pass
   * culls against the sun's own field-wide frustum and so was unaffected, which is exactly the
   * symptom that makes this look like a material bug rather than a culling one.
   *
   * There is nothing to buy back by fixing the sphere instead: these are two draw calls whose
   * instances are scattered over the whole 141-in field, so the mesh is inside the frustum on
   * essentially every frame anyway, and the blobs sit on the tiles under them.
   */
  pollen.frustumCulled = false;
  nectar.frustumCulled = false;
  blobs.frustumCulled = false;

  const group = new THREE.Group();
  group.add(pollen, nectar, blobs);
  const els: BbElements = {
    pollen,
    nectar,
    blobs,
    group,
    sphereGeo: { pollen: pollenGeo, nectar: nectarGeo },
    cadGeo: null,
    detail: 'sphere',
    spin: new Map(),
    lastTick: -1,
    shadowMode: 'real',
    rollingSpin: true,
  };
  setElementDetail(els, detail);
  return els;
}

/**
 * Switch the element GEOMETRY (`elementDetail`, `graphics/settings.ts`). Live and idempotent:
 * both geometries are kept once loaded, so the change is two assignments.
 *
 * The CAD asset is fetched at most once per tab (`loadElementGeometries` caches its promise) and
 * the fetch is NOT awaited — the sphere is on screen the whole time, and the swap happens
 * whenever it lands. A failure is swallowed to one `console.warn`, exactly like
 * `buildBiobuzzField`'s CAD fallback, because the spheres are a complete picture and a missing
 * 22 KB file must not take the scene down.
 *
 * ⚠️ THE ASSET CAN LAND AFTER THE PLAYER HAS CHANGED THEIR MIND. `els.detail` is the intent and
 * is re-read inside the `then`, so a pick of `sphere` made during the fetch is not overwritten
 * by the arrival of geometry nobody wants any more.
 */
export function setElementDetail(els: BbElements, detail: ElementDetail): void {
  els.detail = detail;
  const apply = (): void => {
    const geo = els.detail === 'cad' && els.cadGeo ? els.cadGeo : els.sphereGeo;
    els.pollen.geometry = geo.pollen;
    els.nectar.geometry = geo.nectar;
  };
  apply();
  if (detail !== 'cad' || els.cadGeo) return;
  void loadElementGeometries()
    .then((geo) => {
      els.cadGeo = geo;
      apply();
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D: elements.glb failed to load; the scoring elements stay smooth spheres.', err);
    });
}

/**
 * Switch the element-shadow mode LIVE (`docs/biobuzz/plan-3d.md` §4.4). Nothing is rebuilt: the
 * blob mesh always exists and is simply hidden, and `castShadow` is a per-object flag the
 * shadow pass reads every frame.
 */
export function setElementShadows(els: BbElements, mode: ElementShadows): void {
  els.shadowMode = mode;
  els.pollen.castShadow = mode === 'real';
  els.nectar.castShadow = mode === 'real';
  els.blobs.visible = mode === 'blob';
}

/** the tile-surface offset a blob sits at, and the height over which an airborne element's blob
 * fades and shrinks. A ball two feet up throws a shadow that is wider and fainter, not one that
 * has followed it into the air — which is the whole reason the blob is drawn at z ≈ 0 and not at
 * the element. */
const BLOB_Z = 0.06;
const BLOB_FADE_Z = 40;

/** how far a hive-cell row can fan out before it would clear the cell's own width — same idea as
 * `drawCellContents`'s pitch collapse, simplified: a fixed pitch, clamped to fit. */
const HIVE_ROW_PAD = 1.5;
const HIVE_CELL_ROW_SPAN = BB_HIVE_W - 2 * HIVE_ROW_PAD;

// scratch, reused every frame — no per-frame allocation in the hot per-ball loop
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchMatrix = new THREE.Matrix4();

/** THE ONE POSE. There used to be a second, orientation-free `poseAt` for everything that was
 * not rolling; it is gone because a perforated ball parked in a cell still has to be drawn the
 * way up it arrived — see the pose loop. `scratchQuat` stays as the blob disc's own identity. */
function poseAtQuat(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, quat: THREE.Quaternion): void {
  scratchPos.set(x, y, z);
  scratchMatrix.compose(scratchPos, quat, scratchScale);
  mesh.setMatrixAt(index, scratchMatrix);
}

const spinAxis = new THREE.Vector3();
const spinDelta = new THREE.Quaternion();

/**
 * How far a ball may be seen to move in ONE FRAME and still have that counted as rolling.
 *
 * The fastest thing on this field is a shot leaving a turret at `BB_LAUNCH_V_MAX` (260 in/s),
 * which is 8.7 in between frames at 30 fps and 4.3 at 60 — comfortably under this. Anything
 * past it is not travel, it is a TELEPORT: `derive.ts` re-tags a landed element into a hive
 * cell or a flower stack at that structure's own position, `park()` moves it to a cell centre,
 * a capture takes it off the field and a release puts it back, and a replay scrub or a server
 * correction moves every ball at once. Integrating `d / r` across one of those spins the ball
 * through tens of radians in a single frame, which reads as a pop — so the displacement is
 * DROPPED and only the new position recorded.
 */
const MAX_ROLL_STEP_IN = 12;

/** below this the displacement is dominated by the interpolator's own jitter on a ball that is
 * sitting still, and integrating it makes a resting POLLEN shiver. */
const MIN_ROLL_STEP_IN = 1e-3;

/**
 * A ball's starting orientation, from its own id. Deterministic and cheap — a hash into two
 * angles and a roll — so that the 40 POLLEN a match spawns are not 40 copies of the same face,
 * and so the same id looks the same way on a re-watch of the same replay. Visual only: no
 * element carries an orientation in the sim (`Artifact` is pos/vel/z/vz, and a per-tick
 * quaternion on 56 balls is egress nobody asked for), which is the whole reason this file
 * integrates one instead of reading one.
 */
function seedOrientation(id: number): THREE.Quaternion {
  let h = (id + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  const a = ((h >>> 0) / 4294967296) * Math.PI * 2;
  h = Math.imul(h ^ (h >>> 16), 3266489909);
  const b = ((h >>> 0) / 4294967296) * Math.PI * 2;
  h = Math.imul(h ^ (h >>> 16), 668265263);
  const c = ((h >>> 0) / 4294967296) * Math.PI * 2;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(a, b, c));
}

/**
 * ROLLING WITHOUT SLIPPING, INTEGRATED FROM DISPLACEMENT (owner, 2026-09-21 — a holed ball that
 * slides without turning reads as wrong the instant the holes are visible).
 *
 * The ball turns by `d / r` radians about `up × travel`, where `d` is how far it was seen to
 * move since the LAST DRAWN FRAME. Displacement, not `v · SIM_DT`: the renderer draws
 * interpolated snapshot positions at a free-running frame rate, so a velocity-times-fixed-step
 * integration is off by whatever the ratio of frame rate to tick rate happens to be, while
 * "however far it actually went, divided by the radius" is exactly right at any frame rate,
 * through interpolation, and through a frame the sim did not step at all.
 *
 * Every ball keeps an entry, not only the ones that are rolling — a held POLLEN in a hopper, one
 * parked in a hive cell, one seated in a flower — so that the frame it comes back into play its
 * displacement is measured from where it actually was rather than from wherever it was last
 * loose. `updateBiobuzzElements` is what calls `track` for those; this function is only the
 * rolling half.
 */
function trackSpin(els: BbElements, id: number, x: number, y: number): BbSpin {
  let s = els.spin.get(id);
  if (!s) {
    s = { q: seedOrientation(id), x, y };
    els.spin.set(id, s);
  }
  return s;
}

/** record where a ball is WITHOUT turning it — a held, stock or parked one, and every ball on a
 * frame `rollingSpin` is off for. Its orientation is kept exactly as it was. */
function parkSpin(els: BbElements, id: number, x: number, y: number): THREE.Quaternion {
  const s = trackSpin(els, id, x, y);
  s.x = x;
  s.y = y;
  return s.q;
}

function rollSpin(els: BbElements, id: number, x: number, y: number, r: number): THREE.Quaternion {
  const s = trackSpin(els, id, x, y);
  const dx = x - s.x;
  const dy = y - s.y;
  s.x = x;
  s.y = y;
  const d = Math.hypot(dx, dy);
  if (d > MIN_ROLL_STEP_IN && d < MAX_ROLL_STEP_IN && r > 0.01) {
    // up × travel, up = (0,0,1): (0,0,1) × (dx,dy,0) = (-dy, dx, 0)
    spinAxis.set(-dy, dx, 0).normalize();
    spinDelta.setFromAxisAngle(spinAxis, d / r);
    s.q.premultiply(spinDelta);
  }
  return s.q;
}

/** scratch for the blob's own (uniform) scale — the shared `scratchScale` is a constant 1,1,1
 * every other pose relies on, so a blob must not borrow it. */
const blobScale = new THREE.Vector3(1, 1, 1);

function poseBlob(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, r: number): void {
  // a rising element's shadow spreads and fades; `t` is 0 on the tiles and 1 at `BLOB_FADE_Z`
  const t = Math.min(1, Math.max(0, z / BLOB_FADE_Z));
  const s = r * (1.15 + t * 1.6);
  blobScale.set(s, s, 1);
  scratchPos.set(x, y, BLOB_Z);
  scratchMatrix.compose(scratchPos, scratchQuat, blobScale);
  mesh.setMatrixAt(index, scratchMatrix);
}

export function updateBiobuzzElements(els: BbElements, world: World): void {
  let pollenN = 0;
  let nectarN = 0;
  let blobN = 0;
  /**
   * ⚠️ A PARKED ELEMENT'S `z` MEANS DIFFERENT THINGS UNDER THE TWO PHYSICS, SO THE CONVENTION
   * BRANCHES ON THE SOLVE AND NEVER ON `state.kind`.
   *
   * 3D writes a BOTTOM: the readback is `b.z = t.z - r` (`sim3d/engineImpl.ts`) and a placed
   * flower element is seated `ball.z = PLACE_CENTRE_Z - r` (`sim3d/flower3d.ts`), so every ball
   * a 3D world solves — parked or loose — reports its underside and has to be lifted by `r`.
   * 2D writes a CENTRE for a parked element and only for a parked one: `play.ts`'s `park()`
   * puts a hive element at `CELL_MID_Z` ("where a parked element is drawn to sit") and a flower
   * element at `flowerStackZ`, which is documented as centre heights. Its loose balls still
   * report a bottom.
   *
   * Keying this off the KIND is what put one branch wrong under each solve — a hive element
   * floating 1.4 in high in 2D, a flower element sunk a radius in 3D. And a 2D-physics world in
   * the 3D VIEW is reachable, not theoretical: `GameView.tsx` falls back to `practicePhysics:
   * '2d'` when the 3D chunk fails to load WITHOUT changing the view, which is the same reason
   * `sim3d/tilt.ts` exists as a physics-free module.
   */
  // ONE CHECK, TWO JOBS, because one `World` has one physics: it decides whether `b.z` is an
  // underside (above), and it decides whether the hive row fan runs at all. The fan is a stand-in
  // for a position `park()` never gives a 2D hive element — under 3D every element already has
  // its own solved one, so the grouping pass below is dead work there, and building `hiveIndex`
  // unconditionally is exactly what let the fan apply itself to a 3D world too.
  const bottom = biobuzzPhysics(world) === '3d';
  const blobsOn = els.shadowMode === 'blob';
  const seenSpin = new Set<number>();
  // how many of each alliance's `stock` NECTAR have been put in its box this frame
  const boxed = { red: 0, blue: 0 };
  // A REWIND MOVES EVERY BALL AT ONCE, and none of them rolled to get there: a replay scrub, a
  // reconnect, a server snapshot older than what this client predicted. The displacement clamp
  // in `rollSpin` would catch most of them one ball at a time; this catches all of them for the
  // same reason `Engine3d` rebuilds when `tick` goes backwards, and costs one compare.
  const rewound = els.lastTick < 0 || world.tick < els.lastTick;
  els.lastTick = world.tick;
  const spinning = els.rollingSpin && !rewound;

  // group hive-parked elements by `el` so a shared cell position can be fanned into a row —
  // small (a hive holds at most a handful of elements), so a per-frame Map here is not the
  // "no allocation" hot path the per-ball pose loop below is. 2D-only: see `bottom` above.
  const hiveGroups = new Map<string, Artifact[]>();
  if (!bottom) {
    for (const b of world.balls) {
      if (b.state.kind === 'element' && b.state.el.startsWith('hive:')) {
        const arr = hiveGroups.get(b.state.el);
        if (arr) arr.push(b);
        else hiveGroups.set(b.state.el, [b]);
      }
    }
    for (const arr of hiveGroups.values()) {
      arr.sort((a, c) => {
        const sa = a.state.kind === 'element' ? a.state.slot : 0;
        const sc = c.state.kind === 'element' ? c.state.slot : 0;
        return sa - sc;
      });
    }
  }
  const hiveIndex = new Map<number, { i: number; n: number }>();
  if (!bottom) {
    for (const arr of hiveGroups.values()) {
      arr.forEach((b, i) => hiveIndex.set(b.id, { i, n: arr.length }));
    }
  }

  for (const b of world.balls) {
    const nectar = isNectar(b.color);
    const mesh = nectar ? els.nectar : els.pollen;
    const r = b.r ?? (nectar ? BB_NECTAR_R : BB_POLLEN_R);
    let idx: number;
    if (nectar) {
      if (nectarN >= CAP) continue;
      idx = nectarN++;
    } else {
      if (pollenN >= CAP) continue;
      idx = pollenN++;
    }

    /**
     * ⚠️ EVERY BALL IS TRACKED AND EVERY VISIBLE BALL IS DRAWN AT ITS OWN ORIENTATION, whatever
     * its `state.kind` — a perforated ball that snapped back to the identity rotation the tick
     * it was parked in a hive cell, seated in a flower or taken into a hopper would flip its
     * whole hole pattern in one frame, which is the same class of pop the displacement clamp
     * exists to stop. Tracking a held/stock ball's position costs two writes and is what makes
     * its RELEASE a continuation rather than a teleport.
     */
    seenSpin.add(b.id);
    // a STOCK NECTAR sits in its box, filling the slots in order as the old beads did; one past
    // the box's slots is not drawn (`nectarBox.ts` says why that can only under-draw)
    const slot = b.state.kind === 'stock' ? boxed[b.state.alliance]++ : -1;
    const box = b.state.kind === 'stock' && slot < BB_BOX_SLOTS ? bbNectarBoxSlot(b.state.alliance, slot) : null;
    const spin =
      spinning && (b.state.kind === 'ground' || b.state.kind === 'flight')
        ? rollSpin(els, b.id, b.pos.x, b.pos.y, r)
        : parkSpin(els, b.id, box ? box.x : b.pos.x, box ? box.y : b.pos.y);

    if (box) {
      // resting ON the box's floor slab
      poseAtQuat(mesh, idx, box.x, box.y, BB_BOX_T + r, spin);
    } else if (b.state.kind === 'held' || b.state.kind === 'stock') {
      mesh.setMatrixAt(idx, HIDE);
    } else if (b.state.kind === 'element' && b.state.el.startsWith('hive:')) {
      const row = hiveIndex.get(b.id);
      const span = row && row.n > 1 ? Math.min(HIVE_CELL_ROW_SPAN, (row.n - 1) * HIVE_ROW_PAD) : 0;
      const t = row && row.n > 1 ? row.i / (row.n - 1) - 0.5 : 0;
      // HIVE cell, fanned along local x. The height is `bottom`'s (see the top of this
      // function): under 3D `b.z` is the body's underside and is lifted by `r`, under 2D
      // `park()` has already written the cell's CENTRE height and lifting it again floats the
      // element a radius above the cell. Lifting unconditionally is how the 3D fix — a shot
      // that "teleports slightly downwards" the tick `derive.ts` retags it from `flight` to
      // `element` — leaked into the 2D pipeline it was never about.
      poseAtQuat(mesh, idx, b.pos.x + t * span, b.pos.y, bottom ? b.z + r : b.z, spin);
    } else if (b.state.kind === 'element') {
      // FLOWER stack (`el` is `flower:<index>`, not `hive:...`), same rule as the hive branch
      // above and for the same reason. Under 2D, `flowerStackZ` (`flower.ts`) has written a
      // CENTRE height ("Centre heights (in) of every element in the stack") and it is drawn
      // raw; under 3D the element is a real body seated at `PLACE_CENTRE_Z - r`
      // (`sim3d/flower3d.ts`) and reported as an underside, so it is lifted like any other.
      //
      // ⚠️ DRAWING THIS RAW UNCONDITIONALLY SANK EVERY 3D FLOWER ELEMENT BY ITS OWN RADIUS
      // (1.4–1.8 in) — into the stack it was supposed to be resting on. The opposite mistake
      // shipped first: it used to fall through to the `ground`/`flight` branch and get `+ r`
      // on top of a 2D centre height, which floated it by the same amount.
      poseAtQuat(mesh, idx, b.pos.x, b.pos.y, bottom ? b.z + r : b.z, spin);
    } else {
      // 'ground' | 'flight' — `z` is the height of the ball's BOTTOM above the tile (a resting
      // ball reads z === 0), so the centre is lifted by its own radius. Rolls as it moves.
      poseAtQuat(mesh, idx, b.pos.x, b.pos.y, b.z + r, spin);
      if (blobsOn) poseBlob(els.blobs, blobN++, b.pos.x, b.pos.y, b.z, r);
    }

    if (nectar) els.nectar.setColorAt(idx, new THREE.Color(NECTAR_COLORS[b.color as 'red' | 'blue']));
  }

  // whatever is left over from a previous, larger frame must be hidden, not left stale
  for (let i = pollenN; i < CAP; i++) els.pollen.setMatrixAt(i, HIDE);
  for (let i = nectarN; i < CAP; i++) els.nectar.setMatrixAt(i, HIDE);
  if (blobsOn) {
    for (let i = blobN; i < CAP * 2; i++) els.blobs.setMatrixAt(i, HIDE);
    els.blobs.instanceMatrix.needsUpdate = true;
  }

  // drop orientation state for ids that have left `world.balls` entirely (a new match, a replay
  // seek to a different world) so a long session does not grow this map without bound. A ball
  // that is merely held, stocked or parked is still in the list and KEEPS its entry — that is
  // what makes its release a continuation. See the pose loop's own note.
  for (const id of els.spin.keys()) if (!seenSpin.has(id)) els.spin.delete(id);

  els.pollen.instanceMatrix.needsUpdate = true;
  els.nectar.instanceMatrix.needsUpdate = true;
  if (els.nectar.instanceColor) els.nectar.instanceColor.needsUpdate = true;
  // DRAW ONLY WHAT EXISTS. This used to be a flat `CAP` on both, which was free when an instance
  // was 176 triangles of sphere and is not once it is 2,286 of perforated CAD: a match carries
  // 16 NECTAR against a cap of 56, so three quarters of the heavier mesh's instances were
  // zero-scale degenerates going through the vertex shader — and through the sun's depth pass
  // again on High/Ultra. The hide loops above stay: they keep a stale matrix out of the buffer
  // for the frame the count grows back.
  els.pollen.count = pollenN;
  els.nectar.count = nectarN;
}
