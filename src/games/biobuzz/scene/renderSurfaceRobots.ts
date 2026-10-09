import * as THREE from 'three';
import { FINISHES, ROBOT_FAMILY_FINISH, type FinishId, type RobotFamily } from '../graphics/finishes';
import {
  TwinCache,
  isTwin,
  makeTwin,
  releaseTwin,
  restoreShadow,
  restoreTree,
  setShadow,
  swapTree,
  type DetailAxis,
  type TwinRecipe,
} from './renderSurfaceKit';

/**
 * THE ROBOTS' PHYSICAL FINISHES, for the `materials: 'physical'` row. Part of the lazy
 * `renderSurfaces` chunk; used by BOTH the match and the builder preview.
 *
 * ── ONE GENERATOR, TWO SCENES, ONE SET OF TWINS ─────────────────────────────────────────────
 * `renderRobots.ts`'s materials are module-global (`solidMat` caches one per colour, roughness and
 * metalness in `SHARED_MAT`) and shared by the match, the builder preview, the thumbnails, the
 * gallery and the replay export. The twins are therefore module-global too — ONE cache for the
 * document (`ROBOT_TWINS`), never released, exactly as `SHARED_MAT` is never freed — and the swap
 * is per MESH, so a physical match and a standard thumbnail can draw the same base material in the
 * same second. Nothing here may write a base material (see the kit's header). The preview asks for
 * the same twins through the same `applyRobotSurfaces`, so no material parameter can differ
 * between the builder card and the match at the same settings; the room PROBE is the one thing the
 * card does not get (`renderSurfaces.ts`).
 *
 * ── HOW A PART IS RECOGNISED: BY WHAT IT WAS BUILT AS ───────────────────────────────────────
 * Every robot mesh carries `userData.bbFamily`, set where it is built (`renderRobots.ts`'s `cast`
 * and `tag`, where the argument is REQUIRED, so a new part cannot skip it), and
 * `ROBOT_FAMILY_FINISH` (`graphics/finishes.ts`) maps the family to its finish. The core pass matched
 * the base COLOUR instead, and colour is not identity here: `solidMat(ALU, 0.35, 0.7)` is both the
 * mecanum's steel side plates and the Hogback's plastic core, `ALU_DK` is a frame rail, a shaft
 * and a belt, and `SWEEPER` is a flywheel tyre and a pulley. A mesh with NO tag is left alone —
 * which is also what keeps the builder preview's height envelope (a helper in the same group) and
 * anything else that is not a robot part out of it.
 *
 * ── THE FINISHES THE FAMILIES MAP TO (the numbers are the table's) ─────────────────────────
 *   aluminiumClearAnodised  metal, #c4c7ca, r 0.40, bead-blast grain — goBILDA channel/plates,
 *                           intake arms, braces, the shooter's side plates, the dumper
 *   aluminiumExtrusion      metal, #c4c7ca, r 0.35, anisotropy 0.5 + die lines along the part —
 *                           the Box Tube's three square tubes, the one extruded part with a known axis
 *   steel                   metal, #c4c5c7, r 0.40 — the mecanum/omni side plates, the flywheel shaft
 *   darkCoat                dielectric, KEEPS the scene's dark tone, r 0.45, clearcoat 0.2 — ALU_DK
 *                           rails and plates, the turret ring, the hood, the motor can, dark axles
 *   powderCoatFill          dielectric, KEEPS `chassisFill` (the cosmetic), r 0.5, clearcoat 0.3
 *   siliconeRubber          dielectric, KEEPS the tread/accent colour, r 0.7, IOR 1.41 — wheel
 *                           rollers and tyres, intake rollers and flaps, the flywheel tyre
 *   mouldedNylon            dielectric, keeps colour, r 0.55 — the Hogback core, bearing blocks,
 *                           the claw's jaws and servo, the Box Tube's pulley and spool
 *   rubberBelt              dielectric, keeps colour, r 0.7 — belts (and the pulleys merged into them)
 *   markingPaint            dielectric, keeps BB_FRONT_INK, r 0.6 — the front bar and deck arrow.
 *                           NEVER emissive (owner, 2026-09-27), and neither is any twin: the kit adds none
 *   signVinyl               dielectric, r 0.7 — the ROBOT SIGNS and the deck decal
 *
 * ── THE SIGN AND THE DECAL: PER-ROBOT BASES ─────────────────────────────────────────────────
 * Those two materials are built PER ROBOT (`new MeshStandardMaterial({ map })` in
 * `buildRobotGroup`) and freed by `disposeRobotGroup` only while they are ON a mesh. So their twins
 * do not go in the shared cache: each is made per base (`OWN`, weakly held), and its `dispose` —
 * the one `disposeRobotGroup` calls, since it is the material the mesh is wearing — frees the twin
 * AND the base it stands in for. A revert releases them the same way (`revertRobotSurfaces`).
 *
 * ── THE DECAL'S COLOUR SPACE, FIXED IN PHYSICAL MODE ONLY ───────────────────────────────────
 * `getDecalTexture` never sets `colorSpace`, so the decal's accent is sampled as linear and lands
 * lighter than the same accent on a roller (the sign texture does set it). Changing that there
 * would move the standard picture. The twin instead gets an sRGB CLONE of the texture — the same
 * `Source`, so the same canvas, uploaded once more under the corrected colour space (three keys a
 * texture's GPU copy on its colour space) — cached per texture for the document, as the
 * decal textures themselves are.
 */

/** the finishes that are an EXTRUSION: their die lines, and their anisotropy, follow the part's
 * long axis. The axis is READ OFF THE GEOMETRY (an extrusion is always its longest dimension), so
 * the tag stays one word. */
const EXTRUDED: ReadonlySet<FinishId> = new Set<FinishId>(['aluminiumExtrusion']);

/** every robot twin of a SHARED base in the document — see the header */
const ROBOT_TWINS = new TwinCache(false);

/** per-robot bases (the sign, the decal) → their twin, and back. Weak both ways: when the robot is
 * gone the base is unreachable and so is its twin. */
const OWN = new WeakMap<THREE.Material, THREE.MeshPhysicalMaterial | null>();
const OWN_BASE = new WeakMap<THREE.Material, THREE.Material>();

/** a colour map's sRGB clone, per texture — see the header's DECAL paragraph */
const SRGB = new WeakMap<THREE.Texture, THREE.Texture>();

/** a colour texture as sRGB: itself if it already is, else its cached clone that is */
function srgbOf(tex: THREE.Texture): THREE.Texture {
  if (tex.colorSpace === THREE.SRGBColorSpace) return tex;
  let c = SRGB.get(tex);
  if (!c) {
    c = tex.clone();
    c.colorSpace = THREE.SRGBColorSpace;
    c.needsUpdate = true;
    SRGB.set(tex, c);
  }
  return c;
}

/** the axis a part's geometry is longest along — the extrusion direction of an extruded part.
 * Measured from the positions, NOT `computeBoundingBox`, which would write a shared geometry. */
function longAxis(geo: THREE.BufferGeometry): DetailAxis {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return 2;
  const s = new THREE.Box3().setFromBufferAttribute(pos).getSize(new THREE.Vector3());
  return s.z >= s.x && s.z >= s.y ? 2 : s.y >= s.x ? 1 : 0;
}

/**
 * GIVE AN EXTRUDED PART'S GEOMETRY A TANGENT FRAME, so its twin can be anisotropic: three builds
 * the anisotropic frame from `vUv` or a `tangent` attribute, and a robot's UVs are per-face box UVs
 * that point a different way on every face. Returns whether the geometry has one.
 *
 * THE TANGENT RUNS ACROSS THE PART, NOT ALONG IT. Three stretches ROUGHNESS along the tangent
 * (`lights_physical_fragment`: "the tangent roughness increases with anisotropy"), and a surface
 * with die lines along its axis is rough ACROSS them — its slope varies across the lines and not
 * along them — so the highlight on a real extruded tube is a streak round the tube, across the
 * lines. `axis × n` is exactly that on the four walls; on an end face (normal along the axis) any
 * in-face direction will do, and one is picked so nothing is ever zero-length (three normalises
 * the tangent AND `normal × tangent`, and a zero there is a NaN).
 *
 * ⚠️ IT IS ADDED TO THE SHARED GEOMETRY, AND THAT IS INERT FOR STANDARD MODE: three compiles a
 * tangent attribute into a program only for a material with a normal map or anisotropy
 * (`WebGLPrograms`' `vertexTangents`), which no standard robot material has, and it binds only the
 * attributes a program declares. The cost is one small buffer per extruded part (four floats a
 * vertex; a Box Tube stage is 288 vertices), made once, in physical mode only.
 */
function ensureAxisTangent(geo: THREE.BufferGeometry, axis: DetailAxis): boolean {
  if (geo.getAttribute('tangent')) return true;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nrm) return false;
  const a = new THREE.Vector3().setComponent(axis, 1);
  const fallback = new THREE.Vector3().setComponent(axis === 0 ? 1 : 0, 1);
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const out = new Float32Array(nrm.count * 4);
  for (let i = 0; i < nrm.count; i++) {
    n.fromBufferAttribute(nrm, i).normalize();
    t.crossVectors(a, n);
    if (t.lengthSq() < 1e-6) t.copy(fallback).addScaledVector(n, -fallback.dot(n));
    t.normalize();
    out[i * 4] = t.x;
    out[i * 4 + 1] = t.y;
    out[i * 4 + 2] = t.z;
    out[i * 4 + 3] = 1;
  }
  geo.setAttribute('tangent', new THREE.BufferAttribute(out, 4));
  return true;
}

/** the recipe for one tagged mesh, or null for an untagged one (left standard) */
function recipeFor(mesh: THREE.Mesh): TwinRecipe | null {
  const family = mesh.userData.bbFamily as RobotFamily | undefined;
  const id: FinishId | undefined = family ? ROBOT_FAMILY_FINISH[family] : undefined;
  if (!id) return null;
  const finish = FINISHES[id];
  if (EXTRUDED.has(id)) {
    const axis = longAxis(mesh.geometry);
    const aniso = ensureAxisTangent(mesh.geometry, axis);
    // the axis and the tangent are part of WHICH twin this is: the cache keys on the id
    return { id: `${id}@${axis}${aniso ? 'a' : ''}`, finish, axis, anisotropy: aniso };
  }
  // a robot part moves: its detail is sampled in its OWN axes, so the texture rides with it
  return { id, finish, space: 'object' };
}

/** the twin of a PER-ROBOT base (one with a map) — see the header */
function ownTwin(base: THREE.Material, recipe: TwinRecipe): THREE.MeshPhysicalMaterial | null {
  if (OWN.has(base)) return OWN.get(base) ?? null;
  const twin = makeTwin(base, {
    ...recipe,
    tweak: (t, b) => {
      const map = (b as THREE.MeshStandardMaterial).map;
      if (map) t.map = srgbOf(map);
    },
  });
  if (twin) {
    // the mesh's owner frees what the mesh is wearing; for these that is the base too
    twin.dispose = (): void => {
      releaseTwin(twin);
      base.dispose();
    };
    OWN_BASE.set(twin, base);
  }
  OWN.set(base, twin);
  return twin;
}

const pick = (m: THREE.Material, mesh: THREE.Mesh): THREE.Material | null => {
  const recipe = recipeFor(mesh);
  if (!recipe) return null;
  return (m as THREE.MeshStandardMaterial).map ? ownTwin(m, recipe) : ROBOT_TWINS.get(m, recipe);
};

/** swap every robot mesh under `root` onto its twin. Idempotent: a mesh already swapped is left,
 * so the match can re-walk the whole robots group after one robot was rebuilt.
 *
 * `receive` is whether a robot RECEIVES shadows — see `receiveRobotShadows`. Applied (or taken
 * back) on every walk, so a changed `shadows` row lands on the next one. */
export function applyRobotSurfaces(root: THREE.Object3D, receive = false): number {
  const n = swapTree(root, pick);
  receiveRobotShadows(root, receive);
  return n;
}

/**
 * LET A ROBOT RECEIVE SHADOWS — its turret on its own deck, the hive's shadow across it, the
 * robot beside it — in physical mode with the `shadows` row on `max` only. Standard mode never
 * does (`cast` sets `castShadow` alone, and the reason given there still holds for it), and the
 * flag goes back with everything else on a revert (`restoreTree` restores the parked pair).
 *
 * LOOKED AT before it was turned on (2026-09-27, scene preview, Extreme, school-hall and arena,
 * the sun rig's VSM at 4096 with `bias` −0.0012, `normalBias` 0.035, `radius` 10): free-camera
 * close-ups 22–30 in from a turret and an intake, nearer than any match camera stands, show no
 * acne on the deck, the 0.22 in shooter side plates, the turret plate or the rollers, and no
 * light-bleed band along a plate edge — the turret's shadow falls on its own deck as a soft
 * contact shade. `max` only, because that is the only column whose map is fine enough for it: the
 * sun frustum is ±90.7 in, so a 4096 texel is 0.044 in, and at `soft`'s 2048 it is a blur the
 * width of a plate. Shadows are not a material parameter, so the builder card — which caps its
 * own map at 2048 and never asks for this — is still showing the same material.
 */
export function receiveRobotShadows(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || !o.userData.bbFamily) return;
    if (on) setShadow(o, o.castShadow, true);
    else restoreShadow(o);
  });
}

/** put every robot mesh under `root` back on its base. The shared twins stay cached for the page;
 * a per-robot twin is freed (its base is back on the mesh, and `disposeRobotGroup` frees that). */
export function revertRobotSurfaces(root: THREE.Object3D): void {
  for (const t of restoreTree(root)) {
    const base = OWN_BASE.get(t);
    if (!base || !isTwin(t)) continue;
    OWN_BASE.delete(t);
    OWN.delete(base);
    releaseTwin(t);
  }
}
