import * as THREE from 'three';
import type { GraphicsSettings, GraphicsTier } from '../graphics/settings';
import type { VenueSpec } from '../graphics/environments';

/**
 * THE VENUE — real geometry around the field, so what a player sees past the perimeter is a
 * PLACE and not a blurred image at infinity.
 *
 * ── WHY THIS FILE EXISTS (owner, 2026-09-21: "The graphic lighting environment is too basic.
 *    Make it render an actual environment instead of blurry lights") ─────────────────────────
 * The surround was `scene.background` and nothing else — a painted equirect dome, three's
 * `RoomEnvironment` colour, or a 1k HDRI, every one of them drawn through
 * `backgroundBlurriness` (`renderEnvironment.ts`: 0.16–0.40). Three consequences, all of them
 * in the before captures and none of them fixable by painting a better dome:
 *   • **NO PARALLAX.** `scene.background` is sampled by view DIRECTION. Orbit the field and the
 *     surround does not move — which is the single loudest cue that nothing is out there.
 *   • **NO HORIZON.** These cameras look DOWN at the field, so most of the frame samples the
 *     dome's LOWER half, which is one gradient stop to the next. The `gym` orbit shot was a
 *     brown wash edge to edge.
 *   • **NO GROUND AT ALL ON THE SHIPPING FIELD.** `renderField.ts`'s procedural `bb-room` is
 *     built by the CONSTANTS fallback only — `glbFieldToHandles` never adds it — so the CAD
 *     field hung in the clear colour with its own alliance-area tape running off into the void.
 *
 * ── WHAT IS AND IS NOT THIS FILE'S BUSINESS ────────────────────────────────────────────────
 * ⚠️ **THE FIELD IS AUTHORITATIVE AND NOTHING HERE TOUCHES IT.** No part of this module is
 * inside the perimeter: the ground starts under the field and reaches out, the walls stand at
 * `spec.half` (290–1700 in against the field's own 70.674), and every mesh is in its OWN group
 * so `BbFieldHandles`, the named-object lookups and the RENDER lane's field checks cannot see
 * it. Nothing here reads `World`; a venue is a function of the ENVIRONMENT and of nothing else,
 * so it is built once per pick and never touched again per frame.
 *
 * ⚠️ **AND NOTHING HERE CASTS A SHADOW.** The sun's shadow camera is an orthographic frustum
 * sized to the FIELD (`renderScene.ts`: ±90.674, far 260) precisely so its texel budget is not
 * spent on backdrop — a venue caster is outside it by construction and would cost a depth-pass
 * submission for nothing. The GROUND receives (that is where a robot's shadow lands once it is
 * outside the mat); everything else neither casts nor receives.
 *
 * ── THE COST, AND WHY IT IS SHAPED THE WAY IT IS ───────────────────────────────────────────
 * DRAW CALLS, not triangles, are what a venue can spend badly: a hall is a few dozen boxes, and
 * a few dozen boxes drawn one at a time is a few dozen state changes a Low-tier iGPU pays every
 * frame. So every structural element in here — trusses, columns, stand risers, the crowd, the
 * horizon, the light fittings, the floodlight masts — is an `InstancedMesh` over ONE unit box
 * (`boxes()` below), which makes each CATEGORY one draw call however many members it has. The
 * whole `high` venue is at most nine draws and under 4k triangles; `low` is four.
 */

// ─────────────────────────────────────────────────────────────────────────────── the ladder ──

export type BbVenueDetail = 'low' | 'high';

/**
 * WHICH LEVEL A DEVICE GETS — read off settings that already exist, for the reason
 * `bbWheelDetail` gives at length: §4.4's table has no room for an eighteenth dial and this
 * does not need one. Same two inputs, and `meshDetail: 'low'` set by hand still means low here,
 * so that row keeps its promise.
 *
 * ⚠️ IT SPLITS AT A DIFFERENT PLACE FROM THE WHEELS, ON PURPOSE. `bbWheelDetail` gives Medium
 * the cheap tessellation because a wheel is five lathed meshes per corner per robot — sixteen
 * corners of real geometry, which is a budget. A venue is flat boxes in nine instanced draws,
 * and MEDIUM IS WHERE THE EMPTY BACKDROP LOOKED WORST: it has image-based lighting off (§4.4),
 * so the dome is not even lighting anything, and the void past the wall was the whole picture.
 * Only LOW — the column that exists for a machine that could not hold Medium — takes the cut.
 */
export function bbVenueDetail(settings: Pick<GraphicsSettings, 'meshDetail'>, tier: GraphicsTier): BbVenueDetail {
  if (settings.meshDetail === 'low') return 'low';
  return tier === 'low' ? 'low' : 'high';
}

const LOD: Record<BbVenueDetail, {
  /** ceiling fittings, as a grid. */
  lampCols: number;
  lampRows: number;
  /** radial segments of the studio cyclorama's lathe. */
  cycSeg: number;
  /** solids around an outdoor horizon. */
  horizon: number;
  /** beams under the ceiling, columns against the walls, seating banks, people in them. */
  truss: boolean;
  columns: boolean;
  stands: boolean;
  crowd: boolean;
}> = {
  low: { lampCols: 2, lampRows: 3, cycSeg: 16, horizon: 28, truss: false, columns: false, stands: false, crowd: false },
  high: { lampCols: 4, lampRows: 4, cycSeg: 32, horizon: 64, truss: true, columns: true, stands: true, crowd: true },
};

/**
 * THE GROUND'S z. Copied from `renderField.ts`'s `bb-room` floor and for its reason: the CAD's
 * own ALLIANCE AREA tape lies on the gym floor at z −0.589…−0.579, so a ground plane at −0.5
 * covers it. −0.75 is under the tape and still tight enough to the mat that nothing gaps.
 */
const GROUND_Z = -0.75;

/**
 * ⚠️ **THE SMALLEST AN ENCLOSED VENUE MAY BE, AND IT IS A CAMERA FACT, NOT A TASTE ONE.**
 * `renderCameras.ts` zooms the orbit ring to `ORBIT_RADIUS_MAX` 620 in and the free camera's
 * dolly to 420 in about a target that may itself pan `BB_HALF_X + PAN_MARGIN` off centre. A
 * shell narrower than the furthest of those puts the eye OUTSIDE its own walls, and the shell is
 * `BackSide`, so the walls simply vanish and the shot becomes the far half of the room seen
 * through nothing (measured on the first `workshop`, at 290 in). 660 clears 620 with the
 * near-horizon elevation term to spare. `VenueSpec.half` carries the rest of the reasoning.
 *
 * Going ABOVE a ceiling needs no such guard: the roof is back-faced too, so a top-down orbit
 * past it reads as a cutaway of the room rather than as a hole in one.
 */
const VENUE_MIN_HALF = 660;

/** DETERMINISTIC noise — the same venue every time, on every machine and in every exported
 * frame. Same hash `renderEnvironment.ts`'s star field uses, and the same reason. */
function vRand(i: number): number {
  let t = (i * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ───────────────────────────────────────────────────────────────────────────────── the parts ──

interface BoxSpec {
  x: number;
  y: number;
  z: number;
  /** full extents. A beam running the other way is a swapped `w`/`d`, never a rotation. */
  w: number;
  d: number;
  h: number;
  /** a per-instance tint, multiplied into the material's colour. Only the crowd uses it. */
  tint?: number;
}

/** ONE DRAW CALL PER CATEGORY. Every structural element in this file is a scaled unit box, so a
 * truss, a colonnade, six stand risers or 240 spectators each cost exactly one submission. */
function boxes(name: string, mat: THREE.Material, specs: readonly BoxSpec[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, specs.length);
  mesh.name = name;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  let tinted = false;
  specs.forEach((s, i) => {
    m.makeScale(s.w, s.d, s.h);
    m.setPosition(s.x, s.y, s.z);
    mesh.setMatrixAt(i, m);
    if (s.tint !== undefined) {
      mesh.setColorAt(i, c.setHex(s.tint));
      tinted = true;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tinted && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // the header's note: these are static and scattered over a room, so three's lazily-computed
  // instanced bounding sphere is fine — but the venue never moves, so compute it ONCE and let
  // the culler use it rather than leaving it to the first draw after a matrix write.
  mesh.computeBoundingSphere();
  return mesh;
}

/** a surface material. `roughness` near 1 and `metalness` 0 everywhere: nothing in a venue is a
 * mirror, and `renderScene.ts`'s `tuneMaterials` only touches `metalness >= 0.3`, so the
 * reflections row cannot accidentally reach in here. */
function surface(color: number, map?: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.94, metalness: 0 });
  // ⚠️ ASSIGNED, NOT PASSED. `new MeshStandardMaterial({ map: undefined })` logs
  // "THREE.Material: parameter 'map' has value of undefined" once per material — three checks
  // key PRESENCE, not value — which is a line of console noise per venue mesh per rebuild.
  if (map) mat.map = map;
  return mat;
}

/** a lit fitting. `emissive` rather than a light: three has no area lights in this renderer and
 * the RIG is what actually lights the field (`applyEnvironmentRig`) — this is the FIXTURE, the
 * thing that makes a ceiling read as a ceiling with lights in it.
 *
 * `userData.bloomBase` tags it for BLOOM (Extreme, `renderPost.ts`): at 1.0–1.95 raw a lamp is no
 * brighter than a sunlit white panel, so no threshold could pick one without the other. The match
 * scene raises a tagged emissive by `BLOOM_EMISSIVE_GAIN` for its own pass while bloom is on and
 * puts it back after; `power` itself is the lamp's data and is never changed. `glow` is false for
 * a studio's SOFTBOXES: four 116-in panels are a diffuser, not a lamp, and at the gain a whole
 * softbox in frame bloomed into a haze over the field. */
function fitting(color: number, power: number, glow = true): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: power,
    roughness: 1,
    metalness: 0,
  });
  if (glow) mat.userData.bloomBase = power;
  return mat;
}

/** smooth value noise over one lattice of `n` cells that wraps at 1, so a texture made of it tiles
 * without a seam */
function wrappedNoise(n: number, seed: number): (u: number, v: number) => number {
  const at = (i: number, j: number): number => vRand((((i % n) + n) % n) * 7919 + (((j % n) + n) % n) * 104729 + seed);
  return (u, v) => {
    const x = u * n;
    const y = v * n;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const sx = (x - i) * (x - i) * (3 - 2 * (x - i));
    const sy = (y - j) * (y - j) * (3 - 2 * (y - j));
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}
const MOTTLE_COARSE = wrappedNoise(4, 11);
const MOTTLE_FINE = wrappedNoise(12, 23);
/** 0…1 over the ground texture's unit square: a 12-in cloud with a 4-in one on it */
export const groundMottle = (u: number, v: number): number => 0.65 * MOTTLE_COARSE(u, v) + 0.35 * MOTTLE_FINE(u, v);

/**
 * THE GROUND'S TEXTURE — one 128 × 128 canvas, tiled. Two jobs, and the second is the one that
 * matters: a seam every 48 in gives the eye a SCALE and a parallax reference, which is exactly
 * what a flat-coloured plane cannot do however well its colour is picked. The mottle underneath
 * it is there so a poured slab is not a single flat value either.
 *
 * `gridded` is the difference between a sports floor (a painted panel grid, visible) and a
 * concrete or outdoor surface (mottle only).
 */
function groundTexture(color: number, gridded: boolean): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d')!;
  const r = (color >> 16) & 255;
  const gr = (color >> 8) & 255;
  const b = color & 255;
  // MOTTLE: a smooth, low-contrast cloud, so a poured slab is not one flat value.
  //
  // ⚠️ **A MULTIPLY OF THE BASE, NOT WHITE AND BLACK OVER IT.** A fixed ABSOLUTE step is a grain
  // on `gym`'s 0x8a6e49 and a +40 % lift on `night`'s 0x32373e that covered the car park in
  // white flecks like static (measured in the capture). A percentage reads the same on both.
  //
  // ⚠️ **AND SMOOTH, NOT SPECKS** (2026-09-28, owner: "nothing in graphics that mesh and create
  // weird visual effects"). This was 200 hard-edged ±9 % squares, 0.75–2.6 in across, the same
  // 200 in every 48-in repeat: from any camera above the field the floor read as a pixel mosaic
  // stamped on a grid. Value noise on this texture's own torus (every lattice index wraps, so the
  // repeat has no seam) at two octaves, ±4 %, interpolated — nothing in it is sharper than a few
  // inches, so nothing in it can beat against the pixel grid or against its own repeat.
  g.fillStyle = `rgb(${r},${gr},${b})`;
  g.fillRect(0, 0, S, S);
  // (a context with no pixel access — the smoke lanes' stub — keeps the flat base)
  const img = g.createImageData?.(S, S);
  if (img?.data) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = 1 + (groundMottle(x / S, y / S) - 0.5) * 0.08;
        const o = (y * S + x) * 4;
        img.data[o] = Math.round(r * k);
        img.data[o + 1] = Math.round(gr * k);
        img.data[o + 2] = Math.round(b * k);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }
  if (gridded) {
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0.5, 0);
    g.lineTo(0.5, S);
    g.moveTo(0, 0.5);
    g.lineTo(S, 0.5);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** how many inches one tile of `groundTexture` covers. 48 is a four-foot panel — a real sports
 * floor's board run, and coarse enough that a 1700-in outdoor ground is 70 repeats rather than
 * a moiré. */
const GROUND_TILE = 48;

function buildGround(spec: VenueSpec, round: boolean, reach: number): THREE.Mesh {
  const tex = groundTexture(spec.floor, spec.gridded === true);
  tex.repeat.set((reach * 2) / GROUND_TILE, (reach * 2) / GROUND_TILE);
  const geo = round ? new THREE.CircleGeometry(reach, 48) : new THREE.PlaneGeometry(reach * 2, reach * 2);
  if (round) {
    // a CircleGeometry's UVs run 0..1 across the disc, so the repeat above would tile the WHOLE
    // circle once; rebuild them in world inches so the seam pitch is the same as a plane's.
    const uv = geo.attributes.uv;
    const pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, pos.getX(i) / (reach * 2) + 0.5, pos.getY(i) / (reach * 2) + 0.5);
    }
    uv.needsUpdate = true;
  }
  // ⚠️ **WHITE, NOT `spec.floor` — `color` MULTIPLIES `map`.** The first build passed the floor
  // colour to both and the ground came out its own albedo SQUARED: a 0x555b63 practice-room floor
  // rendered near black, and the measured mat-to-floor relationship the venue colours were chosen
  // against was meaningless. The texture already carries the colour; the tint has to be white.
  const mesh = new THREE.Mesh(geo, surface(0xffffff, tex));
  mesh.name = 'bb-venue:ground';
  mesh.position.z = GROUND_Z;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * THE ROOM SHELL — walls and ceiling as ONE `BoxGeometry` with `side: BackSide`, which is
 * twelve triangles for the whole enclosure and one draw call. The six-material array is what
 * lets the ceiling be its own tone; the box's own bottom face is below the ground plane and is
 * never seen, so it takes the wall material rather than a seventh colour nobody looks at.
 *
 * Group order for a `BoxGeometry` is +x, −x, +y, −y, +z, −z, and this scene is z-up, so index 4
 * is the CEILING.
 */
function buildShell(spec: VenueSpec): THREE.Mesh {
  const wall = surface(spec.wall);
  // the ceiling a shade off the walls: a room whose every surface is one value reads as a box
  const ceilMat = surface(mix(spec.wall, spec.trim, 0.45));
  const mats = [wall, wall, wall, wall, ceilMat, wall];
  for (const m of mats) m.side = THREE.BackSide;
  const geo = new THREE.BoxGeometry(spec.half * 2, spec.half * 2, spec.ceil + 1);
  const mesh = new THREE.Mesh(geo, mats);
  mesh.name = 'bb-venue:shell';
  // from z = −1 (under the ground plane) to the ceiling height
  mesh.position.z = (spec.ceil + 1) / 2 - 1;
  return mesh;
}

/** linear blend of two packed hex colours, `t` = 0 gives `a`. */
function mix(a: number, b: number, t: number): number {
  const ch = (s: number): number =>
    Math.round((((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)) & 255;
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** the ceiling's light fittings, as a grid of shallow panels just under it. */
function buildFittings(spec: VenueSpec, d: (typeof LOD)['low']): THREE.InstancedMesh | null {
  if (spec.lampPower <= 0) return null;
  const specs: BoxSpec[] = [];
  const span = spec.half * 1.35;
  for (let i = 0; i < d.lampCols; i++) {
    for (let j = 0; j < d.lampRows; j++) {
      const x = ((i + 0.5) / d.lampCols - 0.5) * span;
      const y = ((j + 0.5) / d.lampRows - 0.5) * span;
      specs.push({ x, y, z: spec.ceil - 5, w: span / d.lampCols * 0.52, d: 14, h: 3 });
    }
  }
  const m = boxes('bb-venue:fittings', fitting(spec.lamp, spec.lampPower), specs);
  m.layers.set(VENUE_OVERHEAD_LAYER);
  return m;
}

/**
 * ⚠️ THE LAYER FOR ANYTHING THAT HANGS OVER THE FIELD, AND WHY IT HAD TO EXIST.
 *
 * The overhead camera sits at z = 800 looking straight down, and the PiP minimap is a second
 * camera doing the same. The lighting grid is a 5×5 array of beams a couple of feet under the
 * ceiling — directly between those cameras and the field — so the first build of the venue
 * put A MASSIVE CROSS ACROSS THE TOP-DOWN VIEW (owner, 2026-09-21). It is correct from every
 * camera that looks at the field from beside or above-and-in-front, and ruinous from the two
 * that look through it.
 *
 * Visibility cannot do this: the minimap is a SECOND PASS over the same scene in the same
 * frame, so a `visible = false` set for it would also blank the main shot behind it. A LAYER
 * is per-camera and costs nothing per frame.
 *
 * Everything on this layer is opt-IN for a camera: `applyVenueLayers` enables it on the
 * cameras that should see it, and the two overhead ones simply never do.
 */
export const VENUE_OVERHEAD_LAYER = 1;

/** enable the overhead-furniture layer on the cameras that look at the field from the SIDE.
 *  Deliberately NOT the overhead camera and NOT the PiP — see `VENUE_OVERHEAD_LAYER`. */
export function applyVenueLayers(cams: readonly THREE.Camera[]): void {
  for (const c of cams) c.layers.enable(VENUE_OVERHEAD_LAYER);
}

/** beams under the ceiling, both ways — a lighting grid, which is what is actually over an FTC
 * field and what the painted domes' `truss` band was a smear of. */
function buildTruss(spec: VenueSpec): THREE.InstancedMesh {
  const specs: BoxSpec[] = [];
  const z = spec.ceil - 22;
  const reach = spec.half * 1.5;
  for (let i = 0; i < 5; i++) {
    const t = ((i + 0.5) / 5 - 0.5) * reach;
    specs.push({ x: t, y: 0, z, w: 7, d: reach, h: 10 });
    specs.push({ x: 0, y: t, z: z - 11, w: reach, d: 7, h: 10 });
  }
  const m = boxes('bb-venue:truss', surface(spec.trim), specs);
  m.layers.set(VENUE_OVERHEAD_LAYER); // see the constant: it is straight over the field
  return m;
}

/** columns against the walls — the four corners and the four mid-spans. What they buy is
 * PARALLAX: a near-vertical edge at a known distance is the thing that moves most as the camera
 * orbits, and a flat wall has none. */
function buildColumns(spec: VenueSpec): THREE.InstancedMesh {
  const h = spec.ceil;
  const e = spec.half - 9;
  const specs: BoxSpec[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      specs.push({ x: sx * e, y: sy * e, z: h / 2, w: 18, d: 18, h });
      specs.push({ x: sx * e, y: 0, z: h / 2, w: 16, d: 16, h });
      specs.push({ x: 0, y: sy * e, z: h / 2, w: 16, d: 16, h });
    }
  }
  return boxes('bb-venue:columns', surface(mix(spec.wall, spec.trim, 0.6)), specs);
}

/** the geometry of one seating bank, shared by the risers and by the crowd standing on them. */
const STAND_TIERS = 6;
const STAND_TREAD = 32;

function standTier(spec: VenueSpec, j: number): { y: number; h: number } {
  const outer = spec.half - 24;
  const inner = outer - STAND_TIERS * STAND_TREAD;
  return { y: inner + (j + 0.5) * STAND_TREAD, h: 14 + j * 17 };
}

function buildStands(spec: VenueSpec): THREE.InstancedMesh {
  const specs: BoxSpec[] = [];
  const w = (spec.half - 60) * 2;
  for (const sy of [-1, 1]) {
    for (let j = 0; j < STAND_TIERS; j++) {
      const { y, h } = standTier(spec, j);
      specs.push({ x: 0, y: sy * y, z: h / 2, w, d: STAND_TREAD, h });
    }
  }
  return boxes('bb-venue:stands', surface(spec.trim), specs);
}

/**
 * THE CROWD — one instanced box per spectator, deterministically placed and tinted.
 *
 * ⚠️ IT IS TINTED AND IT IS DARK, and both are the point. A bank of identical grey blocks reads
 * as pallets in a warehouse; a bank of varied, muted, low-value ones reads as people at the
 * distance this is actually seen from (250+ in, a few pixels tall). The palette is deliberately
 * desaturated — the field's alliance reds and blues are the only saturated colour that may be in
 * frame, which is the same rule the rigs are held to.
 */
const CROWD_TINTS = [0x4a4f58, 0x5b5148, 0x3f4650, 0x55505c, 0x474b45, 0x625a52];

function buildCrowd(spec: VenueSpec): THREE.InstancedMesh {
  const specs: BoxSpec[] = [];
  const span = (spec.half - 70) * 2;
  // ⚠️ ONE EVERY 21 in AT 9 in WIDE, NOT one every 30 at 11 — and SEATED heights, not standing.
  // The first build's blocks measured a foot across and two and a half feet tall on a 32-in
  // tread, which at this distance read as bollards in a row. A spectator on a bench is a
  // shoulder-and-head silhouette, and the ONLY thing that separates that from a fence at four
  // hundred inches is that the pitch is tight and the heights disagree.
  const per = Math.max(8, Math.round(span / 21));
  let n = 0;
  for (const sy of [-1, 1]) {
    for (let j = 1; j < STAND_TIERS; j++) {
      const { y, h } = standTier(spec, j);
      for (let k = 0; k < per; k++) {
        n++;
        if (vRand(n * 3) < 0.34) continue; // gaps: a full house every time reads as a pattern
        const x = (k + 0.5) / per * span - span / 2 + (vRand(n * 3 + 1) - 0.5) * 7;
        const tall = 15 + vRand(n * 3 + 2) * 9;
        specs.push({
          x,
          y: sy * (y - 5),
          z: h + tall / 2,
          w: 9,
          d: 8,
          h: tall,
          tint: CROWD_TINTS[n % CROWD_TINTS.length],
        });
      }
    }
  }
  return boxes('bb-venue:crowd', surface(0xffffff), specs);
}

/**
 * A SEAMLESS CYCLORAMA, as a lathe. The profile is a quarter-arc cove from the floor into the
 * wall and then straight up — no corner anywhere, which is the one thing a painted gradient
 * cannot imitate: the cove catches the key light as a soft horizontal band, and that band is
 * what reads as a studio.
 *
 * `LatheGeometry` revolves about its own +y, and this scene is z-up, so the whole thing is
 * rotated a quarter turn about x — the same axis-onto-z trick `renderField.ts`'s flower pipes
 * use, and for the same reason.
 */
function buildCyc(spec: VenueSpec, segments: number): THREE.Mesh {
  const R = spec.half;
  // cove radius — generous, because a tight cove reads as a corner; capped so the 660-in floor
  // the camera guard imposes does not curve up before it has cleared the field
  const C = Math.min(spec.half * 0.42, 230);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - C + C * Math.cos(a), C + C * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(R, spec.ceil));
  const geo = new THREE.LatheGeometry(pts, segments);
  const mat = surface(spec.wall);
  mat.side = THREE.BackSide;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'bb-venue:cyc';
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/** softboxes over a studio: four big panels on a rig above the field, which is the whole of a
 * studio's ceiling. No shell — a cyclorama's ceiling is dark and empty by design. */
function buildSoftboxes(spec: VenueSpec): THREE.InstancedMesh | null {
  if (spec.lampPower <= 0) return null;
  const specs: BoxSpec[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      specs.push({ x: sx * 105, y: sy * 105, z: spec.ceil * 0.78, w: 116, d: 116, h: 5 });
    }
  }
  const m = boxes('bb-venue:softbox', fitting(spec.lamp, spec.lampPower, false), specs);
  // ON THE OVERHEAD LAYER, like the truss and the hall fittings, and for the same reason: the rig
  // is straight over the field, so the top-down camera looked THROUGH it and four white 116-in
  // squares covered the field's corners in every studio environment (seen in the Extreme
  // captures, 2026-09-27, where bloom turned them into a white haze over the whole shot).
  m.layers.set(VENUE_OVERHEAD_LAYER);
  return m;
}

/**
 * AN OUTDOOR HORIZON — a ring of solids at `spec.half`, heights from deterministic noise: a
 * treeline, a row of units, the far side of a car park. What it is exactly does not matter and
 * is not meant to: its job is to put a LINE where the ground stops, so the dome's sky reads as
 * sky instead of as the bottom half of a gradient.
 */
function buildHorizon(spec: VenueSpec, count: number): THREE.InstancedMesh {
  const specs: BoxSpec[] = [];
  const chord = (2 * Math.PI * spec.half) / count;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const h = 40 + vRand(i * 2) * 190;
    const depth = 60 + vRand(i * 2 + 1) * 90;
    // square solids on a ring: rotating each to face the centre would need a per-instance
    // quaternion for a silhouette a mile off, so they are axis-aligned and the noise hides it
    specs.push({
      x: Math.cos(a) * spec.half,
      y: Math.sin(a) * spec.half,
      z: h / 2,
      w: chord * 1.15,
      d: depth,
      h,
    });
  }
  return boxes('bb-venue:horizon', surface(spec.trim), specs);
}

/** floodlight masts at the field's corners — the only fittings in the list that stand IN the
 * picture. A dark ground with lights ABOVE the frame is a dark room; a dark ground with four
 * poles on it is a car park at night, and that is the whole difference. */
function buildMasts(spec: VenueSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = 'bb-venue:masts';
  const poles: BoxSpec[] = [];
  const heads: BoxSpec[] = [];
  // ⚠️ 185 in, NOT 280. The first build stood them at 280 and MEASURED the result: from the
  // orbit camera the lit heads were above the frame entirely and the poles crossed the picture
  // as two black bars, which reads as a rendering artefact rather than as a floodlight. At 185
  // the head is in shot from every camera, which is the only reason the mast is there.
  const H = 185;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      poles.push({ x: sx * 210, y: sy * 210, z: H / 2, w: 9, d: 9, h: H });
      heads.push({ x: sx * 210, y: sy * 210, z: H + 8, w: 58, d: 26, h: 12 });
    }
  }
  // the pole reads AGAINST the night sky, so it is lifted well off `trim` — a mast the colour of
  // the horizon behind it is a black bar again, one third as tall
  g.add(boxes('bb-venue:mast-poles', surface(mix(spec.trim, 0x9aa2ae, 0.55)), poles));
  g.add(boxes('bb-venue:mast-heads', fitting(spec.lamp, spec.lampPower), heads));
  return g;
}

// ───────────────────────────────────────────────────────────────────────────── the assembly ──

/**
 * BUILD the venue `spec` asks for, at `detail`. One group, ready for a single `scene.add`, and
 * freed with `renderCore.ts`'s `disposeObject3D` — every geometry, material and map in here is
 * this venue's own, shared with nothing (unlike a robot's, which is why that one is walked
 * separately).
 */
export function buildBiobuzzVenue(input: VenueSpec, detail: BbVenueDetail): THREE.Group {
  const d = LOD[detail];
  const group = new THREE.Group();
  group.name = 'bb-venue';
  // the camera-escape guard, applied HERE rather than trusted to the data — see `VENUE_MIN_HALF`
  const spec: VenueSpec =
    input.kind !== 'outdoor' && input.half < VENUE_MIN_HALF ? { ...input, half: VENUE_MIN_HALF } : input;

  if (spec.kind === 'outdoor') {
    // ground well past the horizon solids so they stand ON it, and inside the cameras' 4000-in
    // far plane with the frame's own diagonal to spare (a disc, not a square, for exactly that)
    group.add(buildGround(spec, true, spec.half * 1.35));
    group.add(buildHorizon(spec, d.horizon));
    if (spec.lampPower > 0) group.add(buildMasts(spec));
    return group;
  }

  if (spec.kind === 'studio') {
    group.add(buildGround(spec, true, spec.half * 0.98));
    group.add(buildCyc(spec, d.cycSeg));
    const soft = buildSoftboxes(spec);
    if (soft) group.add(soft);
    return group;
  }

  // hall and arena: the same enclosure, differing in what is inside it
  group.add(buildGround(spec, false, spec.half + 2));
  group.add(buildShell(spec));
  const fittings = buildFittings(spec, d);
  if (fittings) group.add(fittings);
  if (d.truss) group.add(buildTruss(spec));
  if (d.columns) group.add(buildColumns(spec));
  if (d.stands && spec.stands) {
    group.add(buildStands(spec));
    if (d.crowd) group.add(buildCrowd(spec));
  }
  return group;
}
