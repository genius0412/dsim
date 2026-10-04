/**
 * BIOBUZZ field CAD glTF loader (`docs/biobuzz/plan-3d.md` §8). Loads `field.glb` /
 * `field-low.glb` (`public/models/biobuzz/`, produced by `scripts/field-cad/convert.py` +
 * `scripts/field-cad.mjs` — README next to the files documents the pipeline) and returns the
 * named parts as `THREE.Object3D`s, with materials assigned by part class and shadow flags set.
 *
 * WIRED (the CAD switch-over pass): `scene/renderField.ts`'s `buildBiobuzzField` awaits
 * `loadFieldGlb` first and only falls back to the constants-based field on any failure; the
 * physics side's `sim3d/bodies.ts` reads `fieldColliders3d()` independently (see that file).
 *
 * `three` only here (and in the other `scene/render*.ts` files) — never in `sim3d/**`, per the
 * repo's determinism/bundle-chunking rule (CLAUDE.md, `docs/area/biobuzz.md` §3.9).
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Alliance } from '../../../types';
import { cadCaptureTheta, cadCellBox, fieldColliders3d } from '../sim3d/fieldColliders';

export interface FieldHiveGroup {
  /** static — the triangular base + uprights + damper hardware. World-absolute pose. */
  frame: THREE.Object3D;
  /**
   * the dynamic see-saw body: a `THREE.Group` parked at the hive's PIVOT (world-absolute,
   * from `fieldColliders3d().trays[alliance].pivot` — the same number the physics uses, so the
   * visual and the collider can never disagree about where the hinge is) with the tray mesh
   * re-parented under it via `Object3D.attach` (preserves world transform on reparent, so this
   * works regardless of whatever internal offset `gltf-transform`'s quantize pass baked into
   * the loaded node — see the report's gotchas for why a plain re-position would NOT be safe
   * here). Rotate THIS object about local X to drive the live tilt, exactly like the
   * constants-built fallback's `updateBiobuzzField` already does for its own tray group.
   */
  tray: THREE.Group;
}

export interface FieldGroups {
  floor: THREE.Object3D;
  walls: THREE.Object3D;
  /** the 16 CAD gaffer-tape strips — the LOADING ZONE and GARDEN marks on the tiles and the two
   * ALLIANCE AREA outlines on the gym floor. Present on every field revision that carries tape;
   * `null` only if a future STEP drops it. */
  tape: THREE.Object3D | null;
  /** the parts of the HIVE frame that span BOTH hives — the A-Frame Top Bar (the crossbar) and
   * the ACM logo panel with its sticker. World-absolute and static, like the per-alliance frames;
   * separate only because their centroid sits at x ≈ 0 and a red/blue split by sign would hand a
   * shared part to one hive arbitrarily. */
  sharedFrame: THREE.Object3D | null;
  /** present only if the STEP assembly actually had driver-station geometry (it does not, as
   * of the 2026-09-15 field revision — see the report's part inventory) */
  stations: THREE.Object3D | null;
  hives: { red: FieldHiveGroup; blue: FieldHiveGroup };
  /** index-matched to `config.ts`'s `BB_FLOWERS` (F1..F4) */
  flowers: THREE.Object3D[];
  /** the root scene graph these were pulled out of — mount THIS if the caller wants everything
   * (including the raw hive/flower nodes before `attach()` reparenting) rather than the
   * individually-typed groups above. Most callers want the typed groups instead. */
  root: THREE.Group;
  /** how many triangles `reparentTrayBraces` moved out of the static frame nodes and into the
   * two trays — see that function's header. Non-zero on the shipped asset; zero once the pipeline
   * files the braces as tray parts itself. */
  braceTris: number;
  /** the same count for the PIVOT ROCKER (the two Goal Pivot Bracket plates, the damper holders
   * and the dampers) — see THE PIVOT ROCKER THE PIPELINE ALSO FILED AS FRAME. */
  rockerTris: number;
  /** what the load-time WINDING REPAIR did — see IT IS NOT THE GROUND BARS above. On the shipped
   * asset `reversedTris` is about half of `totalTris` and `openTris` is 0 on the high LOD; both go
   * to zero the day `convert.py` orients its tessellation before merging. Replaces the
   * `groundBeamTris` count, whose three-part `DoubleSide` patch this generalises. */
  winding: ShellRepairStats;
  /** what the PRINTED FIELD MARKINGS block built — all zero on the LOW LOD, by design. */
  markings: FieldMarkings;
}

let sharedLoader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return sharedLoader;
}

/**
 * Resolve a base path (e.g. `models/biobuzz/field`, no extension) or a bare directory
 * (`models/biobuzz`) into the quality-specific `.glb` URL, through Vite's
 * `import.meta.env.BASE_URL` — required for the Electron build, which sets a relative `./`
 * base (`vite.config.ts`) so a bare `/models/...` 404s under `file://`. An already-absolute
 * (`http(s)://`) URL is passed through untouched.
 */
function resolveGlbUrl(base: string, quality: 'high' | 'low'): string {
  if (/^https?:\/\//i.test(base)) return base.endsWith('.glb') ? base : `${base.replace(/\/+$/, '')}/field${quality === 'low' ? '-low' : ''}.glb`;
  const filename = quality === 'low' ? 'field-low.glb' : 'field.glb';
  const trimmed = base.replace(/\/?field(-low)?\.glb$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
  return `${baseUrl}/${trimmed}/${filename}`.replace(/\/{2,}/g, '/');
}

/**
 * ⚠️ NOT `Object3D.getObjectByName` — THREE's `GLTFLoader` runs every node name through
 * `PropertyBinding.sanitizeNodeName` (it has to: node names double as animation-track path
 * segments, where `/` is the separator), and that sanitizer does not escape a `/`, it DROPS
 * it — `"hive_red/frame"` loads as an object literally named `"hive_redframe"`. The loader
 * keeps the true original in `node.userData.name` (`GLTFLoader.js`'s `parseNode`) specifically
 * for cases like this, so lookup goes through that instead of the mangled `.name`.
 */
function findByOriginalName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (hit) return;
    if (obj.userData?.name === name || obj.name === name) hit = obj;
  });
  return hit;
}

function mustFind(root: THREE.Object3D, name: string): THREE.Object3D {
  const found = findByOriginalName(root, name);
  if (!found) throw new Error(`renderFieldGlb: glTF is missing expected node "${name}" — see field-cad's README for the node names convert.py writes`);
  return found;
}

function findOptional(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return findByOriginalName(root, name);
}

/**
 * ⚠️ THE COLOUR COMES FROM THE CAD, NOT FROM THIS FILE.
 *
 * Every glTF material in the asset is named `<finish>#<rrggbb>` and carries that colour in its
 * own `baseColorFactor` — `convert.py` reads it out of the STEP's styled-item chain and
 * `assemble-gltf.mjs` writes one material per (finish, colour) pair. This file supplies only the
 * SURFACE (roughness / metalness / transparency), keyed by the finish.
 *
 * That split is the fix for the owner's "flowers are still the wrong color". The previous version
 * kept a hand-picked hex per part class HERE and another set of placeholders in the assembler, so
 * a flower rendered as three greys (`#e5e7eb` ring, `#c2c4c8` pipes, `#8c929c` base) when the CAD
 * says amber `#ffba52`, green `#5fa73d` and purple `#641c65`. It also had the hive backwards: the
 * alliance colour is the two RIBS (pure `#ff0000` / `#0000ff`), not the white `#e6e6e6` skins.
 * The rib BLUE is the one CAD colour this file overrides — see `ALLIANCE_BLUE_TINT` below.
 * See `docs/biobuzz/field-cad-audit.md` §3 for the full measured table.
 *
 * TWO DELIBERATE OVERRIDES, both flagged in the audit as CAD placeholders rather than intent:
 *  - `glass` keeps the CAD hue but is forced transparent (the STEP has the polycarbonate panels
 *    at an opaque `#e6e6e6`; the real thing is see-through, and a solid perimeter hides the
 *    field from a driver camera outside it).
 *  - `tile` is forced to the sim's own mat token. The CAD gives the soft tiles a flat 50 % grey
 *    placeholder; a real FTC tile is near-black foam, and — more load-bearing — the HUD contrast
 *    pairs (`npm run contrast`) are tuned against `COLORS.mat`/`COLORS.tile`, so a 50 %-grey
 *    floor would quietly break them. The `tiles` node is hidden at runtime anyway
 *    (`renderField.ts` draws the seam grid on its own textured plane), so this is a fallback.
 */
const FINISHES = ['tile', 'glass', 'metal', 'plastic', 'decal', 'tape', 'misc'] as const;
type Finish = (typeof FINISHES)[number];

/** the sim's own floor token — see the `tile` override above. Matches `C.COLORS.mat`; the
 * literal rather than the import because `renderField.ts` (which owns the floor) already
 * depends on THIS file, and importing back would be a cycle. */
const TILE_TONE = 0x2a2e33;

/**
 * ⚠️ CLEAR PLASTIC IS A POLICY, NOT A COLOUR — and the CAD cannot tell you which parts want it.
 *
 * The STEP paints every clear polycarbonate panel on this field the same placeholder white
 * (`#e6e6e6`) it paints the solid white parts, so "is this see-through?" has to be decided PART
 * BY PART, here, against the real field. 2026-09-18 playtest: "many completely transparent /
 * semi-transparent panels are rendered as white or opaque white that is too strong."
 *
 * The classification, made from the GLB's own node × material inventory
 * (`docs/biobuzz/field-cad-audit.md` §3 has the measured CAD colour of every part):
 *
 *  CLEAR  `glass#*`  in `walls`                — `FTC Field Side Glass`, the perimeter panels.
 *  CLEAR  `plastic#e6e6e6` in a `hive_<a>` tray    — `Hive Goal {Top,Back,Bottom} Skin`, the three
 *                                                polycarbonate skins that make a CELL. They are
 *                                                the ONLY `plastic#e6e6e6` in a tray node (the
 *                                                `Basket Base Tube` is the `metal` finish and
 *                                                the ribs are `plastic#ff0000`/`#0000ff`), so
 *                                                the node+material pair names them exactly.
 *  OPAQUE `plastic#e6e6e6` in `hive_shared/frame` — `am-5877 ACM Panel`, an aluminium-composite
 *                                                logo board. Same material name, opposite answer:
 *                                                this is why the rule is keyed on the NODE too.
 *  OPAQUE `plastic#641c65` (flower backstop), `#5fa73d` (HIPS pipes), `#ffba52` (top ring),
 *         `#303030`, every `metal#*`, `decal#*`, `tape#*` — solid parts with a real CAD colour.
 *
 * ⚠️ AND A CLEAR PANEL IS NOT A PER-MATERIAL NUMBER — IT IS WHAT THE LAYERS SUM TO.
 *
 * The first pass set a "reasonable" 0.22 / 0.3 and looked right on a single panel from four feet
 * away. From the DRIVER camera it was not (2026-09-19 re-test: "the HIVE cell skins still read as
 * WHITE BOARDS… the far and side walls read as solid beige bands"), because four things stack:
 *  - LAYER COUNT. A cell puts floor + roof + back between the eye and a ball, a look across the
 *    field puts the near wall and the far wall in the way, and `DoubleSide` doubled every one of
 *    them. At 0.22 each, six surfaces sum to 1 − 0.78⁶ = **78 % opaque**. `FrontSide` is right for
 *    every one of these parts — each is a closed SOLID (the 0.020-in skins tessellate as a slab;
 *    the raycast in `checkTrayFloorAgreement` hits both of a floor's faces), so the near surface
 *    is always front-facing whichever side the camera is on, and the count halves.
 *  - ALPHA. 0.08 for a wall panel, 0.10 for a cell skin. Through the worst stack that is still
 *    only ~27 %, which is what clear polycarbonate actually does: near-invisible face-on.
 *  - BASE COLOUR. `#e6e6e6` is the STEP's placeholder for "white plastic", and a near-white base
 *    under any lighting is a white haze however low the alpha goes. Overridden to a cool neutral
 *    (`CLEAR_PANEL_TINT`) — the third deliberate CAD override in this file, for the same reason as
 *    the other two: the value is a placeholder, not intent.
 *  - `envMapIntensity`. At 1.0 a glossy panel mirrors the environment; the warm practice HDRI is
 *    exactly where the "beige" came from. 0.15 keeps a glancing highlight and nothing else.
 *
 * ⚠️ AND THE OUTLINE PASS THAT USED TO FINISH THIS OFF IS GONE — IT DREW NO OUTLINE (owner bug 3,
 * 2026-09-19: "there are stray lines on the transparent panels of the hives").
 *
 * `addPanelEdges` ran `THREE.EdgesGeometry(mesh.geometry, 25)` over a tray's `plastic#e6e6e6`
 * mesh, which is ONE merged, welded and per-primitive-decimated soup of SIX cell skins. Measured
 * on the shipped `field.glb`, red tray: **3,552 segments, 2,811 of them 0.01 in or shorter, and
 * the LONGEST is 0.84 in** — on skins that are 20 in wide and 11.75 in deep. Not one segment in
 * it is a panel boundary. The mesh has no boundary edge at all (each skin is a closed 0.020-in
 * slab), so every segment came from the 2,994 tessellation creases the decimator left plus 317
 * non-manifold edges: 125 in of sub-inch dashes sprayed over the panel in `#b9c6d2`. That is the
 * report, exactly.
 *
 * Nothing replaces it, because nothing needs to: a CELL's shape is drawn by its two opaque
 * alliance-coloured GOAL RIBS (`plastic#ff0000`/`#0000ff`, 46 k triangles, a perforated frame
 * plate at the divider end AND at the mouth — the audit's §4.2), and the mouth-end rib IS the
 * aperture outline a driver aims at. The skins carry a touch more alpha instead.
 *
 * `depthWrite: false` + a `renderOrder` past every opaque object stays: three.js sorts transparent
 * objects by render order, not per triangle, so two clear panels must never fight over a pixel.
 */
export const WALL_PANEL_OPACITY = 0.08;
/**
 * the hive CELL skins sit denser than the perimeter — they are what a driver reads the cell's
 * shape off, and there are fewer of them in any one line of sight. 0.10 → 0.13 when the outline
 * pass came out, and **it is still 0.13** — which is worth writing down, because 0.18 was tried
 * on 2026-09-19 and MEASURED, and it moved the view the owner was reporting by 0.1 of a level.
 *
 * Alpha is a multiplier on `bg − tint`, and against the lit room behind a hive the ground IS the
 * tint's own value, so there is nothing there for a multiplier to scale. That is the whole of why
 * three separate shading passes and then the opacity itself all failed the same way; the answer
 * is `PANEL_VEIL`, which ADDS. See the dielectric header.
 */
export const CELL_PANEL_OPACITY = 0.13;
/**
 * how much of the environment map a clear panel gathers. ⚠️ This is a damper on the DIFFUSE
 * pickup and nothing else now — `PANEL_ENV_SPEC_RESTORE` undoes it for the mirror term. See the
 * dielectric header below for why that split had to be made.
 */
const CLEAR_ENV_INTENSITY = 0.15;
/** the tone every clear panel is forced to, overriding the STEP's `#e6e6e6` placeholder: a cool
 * neutral that disappears into whatever is behind it instead of hazing it white. */
const CLEAR_PANEL_TINT = 0x7d8b96;
/**
 * ⚠️ NOT 0.08. A hive that has played a season is scuffed, and 0.08 is showroom acrylic: it
 * gives a mirror lobe so tight that the light rig only lands on a panel at the exact mirror
 * angle, which is a point highlight and not a sheen. 0.18 spreads the same energy across the
 * face, which is what makes the sheet read as a surface from an arbitrary camera — and it is the
 * half of the fix for the back panel that does NOT depend on the viewing angle.
 */
const PANEL_ROUGHNESS = 0.18;
/**
 * ⚠️ THE FOURTH DELIBERATE CAD OVERRIDE (owner bug 12, 2026-09-19: "the blue alliance looks too
 * purple — are you sure that is the exact colour AndyMark uses?").
 *
 * The STEP gives the hive Goal Ribs `plastic#0000ff`, and pure `#0000ff` is OKLCH hue 264.1° —
 * 1.7° off the most violet blue sRGB can express. An assembly carrying pure `#ff0000` AND pure
 * `#0000ff` is carrying placeholder part colours, the same way its `#e6e6e6` "white plastic" is a
 * placeholder rather than a paint (see `CLEAR_PANEL_TINT` above, which overrides it for that
 * reason). So the CAD is authoritative for DIMENSIONS — the owner's 2026-09-18 ruling, and
 * nothing here touches one — and is NOT authoritative for this colour.
 *
 * `ALLIANCE_BLUE_TINT` is the one BIOBUZZ blue every other surface takes (`draw.ts`'s
 * `ELEMENT_FILL` header carries the measurement): hue 252.9°, the least violet a saturated blue
 * gets, at the most chroma sRGB has there. APPROX — no authoritative AndyMark blue was found.
 * RED is left at the CAD's `#ff0000`: a pure red still reads as red, and the owner named only
 * blue.
 */
const CAD_ALLIANCE_BLUE = 0x0000ff;
const ALLIANCE_BLUE_TINT = 0x007be1;
/** matches `renderField.ts`'s `WALL_RENDER_ORDER` — drawn after every opaque object so two
 * transparent walls (or a wall and a robot) never fight over which one occludes the other. */
const WALL_RENDER_ORDER = 10;
/** the cell skins are INSIDE the field, so they draw before the perimeter and after everything
 * opaque. Matches `renderField.ts`'s `CELL_RENDER_ORDER`. */
const CELL_RENDER_ORDER = 5;

/**
 * ── THE PANEL IS A DIELECTRIC, NOT A CONSTANT ALPHA (owner, 2026-09-19: "the hive's back panel
 *    reads as perfectly transparent from behind, and should not") ───────────────────────────
 *
 * FIRST, WHAT IT IS NOT. It is not back-face culling. Measured on the shipped `field.glb`, red
 * tray, the `plastic#e6e6e6` primitive: **0 boundary edges**, 6,809 manifold and 317
 * non-manifold, with the face normals in matched opposite pairs (±y 1,203 / 1,233 tris, ±x 204 /
 * 192). Every skin is a closed 0.020-in slab, so from behind a panel you are looking at the
 * FRONT face of its rear skin and `THREE.FrontSide` culls nothing. The panel is drawn. It is
 * just drawn at `CELL_PANEL_OPACITY`.
 *
 * AND THAT IS THE BUG. `transparent` + a constant `opacity` multiplies the WHOLE shaded fragment
 * by that number — diffuse and SPECULAR alike. So the more see-through the sheet is, the fainter
 * its reflection gets, which is backwards: a reflection does not pass through the sheet, it
 * bounces off the front of it, and it is the ONLY thing you see when there is nothing behind the
 * panel to tint. A real polycarbonate sheet at 0.13 transmittance-equivalent still shows a
 * sheen, because the 5 % it reflects is 5 % of the room, not 0.13 × 5 %.
 *
 * So two things change, and both are physics rather than taste:
 *
 *  1. **FRESNEL ALPHA.** Schlick against polycarbonate's own IOR. The face-on opacity is left at
 *     EXACTLY the measured `WALL_PANEL_OPACITY` / `CELL_PANEL_OPACITY` — the 2026-09-19 re-tune
 *     that stopped these reading as white boards is untouched, and the six-layer stack it was
 *     tuned against is unchanged face-on — and what is added is the EXCESS over normal
 *     incidence, rising to `PANEL_GRAZE_OPACITY` at grazing. That is the sheen, and it is also
 *     the EDGE: a slab's 0.020-in side face is at grazing incidence from almost everywhere, so
 *     it picks up the full term and the panel gets a boundary.
 *  2. **THE SPECULAR IS ADDED BACK UN-ATTENUATED**, capped. Undoing the alpha multiply on the
 *     reflected term costs a factor of `1/a − 1`, which at the wall's 0.08 is 11.5 — hence the
 *     cap, which does not bind on either shipped value and exists so a future lower opacity
 *     cannot divide by something tiny.
 *
 * ⚠️ **AND NOTHING HERE DRAWS A LINE.** The edge this restores is a per-pixel term on the
 * panel's own faces: no `EdgesGeometry`, no `LineSegments`, no new geometry and no new mesh, so
 * the 2026-09-19 stray-dash bug (`addPanelEdges`, whose autopsy is in the policy header above)
 * cannot come back through it. The RENDER lane's "the loader runs no edge/outline pass at all"
 * check still holds over this file, and it is the thing that proves it.
 *
 * ── AND IT DID NOT FIX IT (same owner, same day, second report: "the back panel of the hive is
 *    TOO transparent when seen from the back, but from the front it looks fine") ──────────────
 *
 * MEASURED, in the real shader, from a hidden Electron window driving `scripts/scene-preview`:
 * the red up CELL's back skin rendered twice per camera, once visible and once hidden, with the
 * skin's OWN silhouette as the denominator (a mean over "pixels that changed" cannot see a panel
 * that vanished — the vanished part is not in it) and the contrast taken as WEBER, |ΔL| / L
 * behind, because +15 on the dark tiles and +15 on the lit room are not the same picture.
 *
 * | the same skin, from   | mean \|ΔL\| | L behind | \|ΔL\|/L |
 * |---|---|---|---|
 * | the MOUTH side (red / blue) | 29.2 / 28.1 | 86 / 112 | **34 % / 25 %** |
 * | BEHIND the cell (red / blue) | 8.9 / 11.3 | 175 / 186 | **5.1 % / 6.1 %** |
 *
 * A five- to sixfold deficit, and the SIGN flips: from behind, the sheet's whole signal is a
 * −8.9 DARKENING of a bright ground. Two things cause that, and the first pass addressed neither.
 *
 *  1. **WHAT IS BEHIND IT.** From the mouth the skin is seen against the dark cell and the dark
 *     tiles; from behind, at driver eye height, a cell sits at z ≈ 53–65 in and the ground behind
 *     it is the lit room. A constant-colour sheet is a fine silhouette on black and nothing at
 *     all on white. The first pass made the panel's own colour more correct and left it CONSTANT,
 *     so it could not help here.
 *  2. **THE ONLY NON-CONSTANT TERM WAS THE KEY LIGHT.** Moving the sun through four positions and
 *     re-measuring the same two cameras: from the mouth 64 / 69 / 69 / 70 % — flat, because the
 *     ground is dark either way — and from behind 6.1 / 3.7 / **13.1** / 3.0 %. So the sheen the
 *     first pass restored IS what carries the back view, and it is worth 3 % of a background on a
 *     bad day. That is the hypothesis this pass was opened with, and it is true but small.
 *
 * ⚠️ **THE REAL DEFECT IS THAT `envMapIntensity` WAS DAMPING THE MIRROR.** A `MeshStandardMaterial`
 * uses `envMapIntensity` for BOTH the environment's diffuse irradiance and its specular radiance,
 * and 0.15 was chosen (correctly) to stop a near-white placeholder base soaking up a warm HDRI
 * and reading beige. But it took the REFLECTION down with it: the file computes `PANEL_F0` =
 * 0.0513 from polycarbonate's own IOR and then rendered 15 % of it — the sheet was reflecting
 * 0.8 % of the room where the physics says 5.1 %. And a reflection is the one term that is
 * light-rig-independent and BACKGROUND-independent: it is bright where the panel faces the room's
 * lit half and dark where it faces the floor, so it reads against a bright ground and a dark one.
 *
 * So `CLEAR_ENV_INTENSITY` is now a DIFFUSE damper only, and `PANEL_ENV_SPEC_RESTORE` puts the
 * mirror back to 1.0 inside the same un-attenuation the sheen already uses. The beige it was
 * guarding against cannot return through it: what is restored is `indirectSpecular`, weighted by
 * the dielectric's own Fresnel, not the irradiance that tinted the sheet.
 *
 * ⚠️ **AND SO DID EVERY OTHER MULTIPLIER, INCLUDING THE OPACITY.** The mirror restore, a
 * scuff-scatter haze, a damped ambient and finally `CELL_PANEL_OPACITY` 0.13 → 0.18 were each
 * measured against that camera and each moved it by **under 0.1 of a level**. The next section
 * is why, and the opacity is back at 0.13.
 *
 * And the third term, which is what carries an ordinary look rather than an extreme one:
 * **thickness** (`PANEL_PATH_MIN_COS`). The first pass's alpha was flat until the last 20° and it
 * justified that as buying the EDGE, "a slab's 0.020-in side face at grazing from almost
 * everywhere" — at 78 in, a driver's distance from a hive, that face is 0.03 px wide and draws
 * nothing. A sheet at an angle shows more SHEET, not more edge.
 *
 * ── AND THAT DID NOT FIX IT EITHER, AND THE REASON IS THE BLEND ITSELF ───────────────────────
 *
 * Third look at the same two pictures, and the back view was still the back view: the V of the
 * cell's skins effectively absent, the three NECTAR behind them perfectly crisp, while the SAME
 * skins in the mouth view read as present smoky sheets.
 *
 * ⚠️ **ALPHA-BLENDING TOWARD A MID-GREY TINT IS A NO-OP ON A MID-TONE GROUND.** The blend is
 * `bg·(1 − a) + tint·a`. `CLEAR_PANEL_TINT` is 0x7d8b96 — a MID grey — so on a ground near its
 * own value the expression barely moves however the shading is tuned, and the "ND ceiling" the
 * previous paragraph called physics is a property of the BLEND MODEL, not of polycarbonate. On
 * the dark room behind the mouth view the same blend lightens visibly, which is the whole of the
 * front/back asymmetry. That is why the mirror restore moved it by 0.1 of a level, why a damped
 * ambient moved it by 0.1 of a level, and why raising the alpha moved it by 0.1 of a level: all
 * three are multipliers on a difference that is already ≈ 0.
 *
 * A real scuffed sheet under arena lights does not only subtract. Its surface scatter ADDS a
 * milky veil, and an added term is worth exactly what it is set to against a black ground, a
 * mid-grey one and a white one alike. So the cell skins get **`PANEL_VEIL`**: view-independent,
 * light-independent, un-attenuated by the alpha (the trick the sheen already uses), a cool
 * near-white rather than the transmission tint, and CAPPED, because transparent layers each add
 * and the mouth view looks through three of them at once.
 *
 * It is on the CELL skins ONLY. The perimeter walls keep their face-on 0.08 and get no veil: the
 * 2026-09-18 report about those was that they read as solid beige bands, they measure present
 * from every camera checked here, and the owner has not said otherwise.
 *
 * AFTER — mean per-channel Δ over the panel's own silhouette, bracket = the share of the
 * background's own luminance SPREAD the panel leaves behind, which is what says the elements are
 * still readable through it. ⚠️ These are the numbers WITH the culling fix below, which landed
 * after this section was written and is what actually answered the report; the veil came down
 * from 0.075 to 0.018 once the sheets it was standing in for were being drawn again.
 *
 * | camera | red | blue |
 * |---|---|---|
 * | the hive from its OWN driver station | 25.7 → **67.7** (82→66 %) | 25.3 → **67.7** (82→67 %) |
 * | the hive from the FAR station | 23.4 → **58.8** (85→72 %) | 23.6 → **58.9** (84→72 %) |
 * | 3/4 orbit BEHIND, 25° up | 32.0 → **63.4** (73→64 %) | 33.1 → **64.5** (72→59 %) |
 * | tight, from BEHIND the cell | 36.4 → **66.4** (72→83 %) | 41.0 → **77.5** (69→66 %) |
 * | tight, through the MOUTH | 34.3 → **60.4** | 41.5 → **68.8** |
 * | **the BACK SKIN alone, from behind** | 12.2 → **34.5** (104→73 %) | 10.9 → **36.1** (97→71 %) |
 * | the same skin from the MOUTH side | 32.7 → **38.7** (76→70 %) | 40.5 → **52.5** (65→62 %) |
 * | the perimeter WALLS | 18.1 → **22.3** (86→82 %) | 21.5 → **23.6** (85→84 %) |
 *
 * The row that matters is the back skin ALONE: 12.2 against 32.7 before — a sheet that was
 * invisible from one side of itself — and 34.5 against 38.7 after, **89 % of what the same sheet
 * shows from the mouth**, which is the parity the report asked for. It did not move at all under
 * four shading passes because it was not being drawn; see below.
 *
 * ⚠️ AND THE KEY LIGHT NO LONGER DECIDES IT. The same back view under the four sun positions:
 * **69.0 / 71.1 / 72.2 / 72.5**, a 5 % spread, against 31.1 / 32.6 / 33.1 / 34.2 before.
 */
/**
 * ── IT WAS BACK-FACE CULLING AFTER ALL, AND THE PROOF THAT IT WAS NOT WAS COUNTING THE WRONG
 *    THING (2026-09-19, fourth pass) ─────────────────────────────────────────────────────────
 *
 * Every paragraph above this one is a fix to the SHADING of a sheet that, from behind, was not
 * being rasterised at all. The picture said so plainly and three passes read past it: in a
 * from-behind render the cell's FLOOR and SIDE skins were milky and the two diagonal sheets that
 * close the back of the cell were simply absent — the NECTAR behind them crisp, the gold room
 * showing through with no film of any kind. A term that is view-independent, light-independent
 * and un-attenuated by alpha cannot be invisible on a face that is being drawn.
 *
 * ⚠️ **THE OLD DISPROOF BINNED ONLY AXIS-ALIGNED NORMALS.** It reported "face normals in matched
 * opposite pairs (±y 1,203 / 1,233 tris, ±x 204 / 192)" and concluded every skin is a closed
 * slab. A cell's back is a GABLE: its two sheets are diagonal, normal ≈ (0.54, 0, ±0.84) in the
 * tray frame, so they were in neither bin and the count could not see them. "0 boundary edges"
 * did not catch it either — that was measured over a welded, decimated six-skin soup with 317
 * non-manifold edges, where it means nothing.
 *
 * MEASURED PROPERLY, area-weighted, per PLANE (triangles clustered by plane normal and offset),
 * in each tray's own local frame — a closed slab's two faces land in one cluster and split its
 * area both ways; a single sheet puts all of it one way:
 *
 * | part | planes | area facing + / − | balance |
 * |---|---|---|---|
 * | red tray `plastic#e6e6e6` | 5 | every one 100 / 0 | **0 %** |
 * | blue tray `plastic#e6e6e6` | 7 | every one 100 / 0 | **0 %** |
 * | `walls` `glass#e6e6e6` | 4 big + 10 posts | every one 100 / 0 | **0 %** |
 *
 * **Not one clear surface on this field is a closed slab.** They are single-sided sheets, wound
 * to face INWARD — into the cell, into the field — which is exactly the owner's report in both
 * of its halves: correct through the mouth and from inside the field, gone from behind a cell
 * and from outside the perimeter. Rendered the same camera three ways, the red up cell from
 * behind at 46 in: `FrontSide` 294,116 px of clear surface, **`DoubleSide` 757,157**, `BackSide`
 * 733,645. Two thirds of it was being thrown away.
 *
 * ⚠️ **SO `DoubleSide` DOES NOT DOUBLE ANYTHING HERE, AND THE HEADER THAT SAYS IT DOES WAS
 * REASONING FROM THE SAME WRONG PREMISE.** "`DoubleSide` doubled every one of them… at 0.22 each,
 * six surfaces sum to 78 % opaque" is true of closed slabs and false of sheets: one sheet drawn
 * from either side is ONE layer. The white-board fix was the ALPHA (0.22 → 0.13 / 0.08), and that
 * is untouched. What `FrontSide` bought was not half the layers, it was half the field.
 *
 * ⚠️ **THE ASSET IS THE REAL DEFECT AND THIS IS THE LOAD-TIME COMPENSATION.** `convert.py` /
 * `assemble-gltf.mjs` export these panels as open sheeting rather than as the solids the STEP
 * models; `public/models/biobuzz/README.md` carries the note for whoever next touches that
 * pipeline. Nothing is regenerated in this pass — the renderer copes, and the RENDER lane pins
 * the measurement so the day the asset ships closed slabs this decision gets revisited rather
 * than silently doubling them.
 */
export const CLEAR_SHEETS_ARE_SINGLE_SIDED = true;

/** how far apart two faces of the same slab may sit and still be recognised as ONE plane. The
 *  skins are 0.020 in; a quarter inch is loose enough to survive the decimator's jitter and far
 *  tighter than any gap between two genuinely different sheets of this field. */
const SHEET_PLANE_TOL_IN = 0.25;

/**
 * IS THIS CLEAR GEOMETRY MADE OF CLOSED SLABS OR OF OPEN SHEETS — the measurement the four
 * paragraphs above rest on, exported so the RENDER lane runs THIS code over the shipped `.glb`
 * rather than a re-implementation that could agree with a wrong belief.
 *
 * Triangles are clustered by their plane (unsigned normal, quantized offset) and each cluster's
 * area is split by which way its triangles wind. A closed slab puts its two faces in one cluster
 * and splits the area evenly; an open sheet puts all of it one way. `twoFacedFraction` is the
 * share of the total area that has an opposing partner in its own plane — near 1 means slabs and
 * `FrontSide` is safe, near 0 means sheeting and `FrontSide` deletes it from one whole side.
 *
 * `toLocal` is optional and exists because a glTF with `KHR_mesh_quantization` stores positions
 * normalized and keeps the scale on the node: pass the mesh's own world matrix or the areas come
 * out in units of nothing.
 */
export function sheetFacingBalance(
  geo: THREE.BufferGeometry,
  toLocal?: THREE.Matrix4,
): { planes: number; totalArea: number; twoFacedFraction: number; worstPlaneArea: number } {
  const pos = geo.getAttribute('position');
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const planes = new Map<string, { fwd: number; back: number }>();
  let totalArea = 0;
  for (let t = 0; t < count; t += 3) {
    const i0 = index ? index.getX(t) : t;
    const i1 = index ? index.getX(t + 1) : t + 1;
    const i2 = index ? index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    if (toLocal) {
      a.applyMatrix4(toLocal);
      b.applyMatrix4(toLocal);
      c.applyMatrix4(toLocal);
    }
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    const area = n.length() / 2;
    if (area <= 1e-9) continue;
    n.divideScalar(area * 2);
    totalArea += area;
    // an UNSIGNED plane key, so the two faces of one slab collide and a lone sheet does not
    const sign = n.x + n.y * 1e-3 + n.z * 1e-6 >= 0 ? 1 : -1;
    const ux = n.x * sign;
    const uy = n.y * sign;
    const uz = n.z * sign;
    const d = ux * a.x + uy * a.y + uz * a.z;
    const key = `${ux.toFixed(2)},${uy.toFixed(2)},${uz.toFixed(2)}|${Math.round(d / SHEET_PLANE_TOL_IN)}`;
    const p = planes.get(key) ?? { fwd: 0, back: 0 };
    if (sign > 0) p.fwd += area;
    else p.back += area;
    planes.set(key, p);
  }
  let twoFaced = 0;
  let worst = 0;
  for (const p of planes.values()) {
    twoFaced += 2 * Math.min(p.fwd, p.back);
    worst = Math.max(worst, p.fwd + p.back);
  }
  return {
    planes: planes.size,
    totalArea,
    twoFacedFraction: totalArea > 0 ? twoFaced / totalArea : 0,
    worstPlaneArea: worst,
  };
}

/** polycarbonate's own refractive index (Makrolon / Lexan datasheet nD = 1.586), which is where
 *  every number below comes from rather than from a look. */
const PANEL_IOR = 1.586;
/** Schlick's F0 for that IOR against air, ((n−1)/(n+1))² = 0.0513. */
const PANEL_F0 = ((PANEL_IOR - 1) / (PANEL_IOR + 1)) ** 2;
/** what a clear panel's alpha reaches at grazing incidence. A dielectric's reflectance goes to
 *  1.0 there; this is deliberately well short of it, because the panel is still only ~1/16 in of
 *  plastic and a hive wall that went fully opaque edge-on would hide the elements behind it. */
const PANEL_GRAZE_OPACITY = 0.55;
/** ceiling on the specular the shader adds back. See point 2 above. */
const PANEL_SHEEN_MAX = 12;
/**
 * undoes `CLEAR_ENV_INTENSITY` for the REFLECTED term only, so the sheet mirrors the room at the
 * `PANEL_F0` its own IOR says (5.1 %) rather than at 15 % of it (0.8 %). Written as the reciprocal
 * rather than as a number so the two can never drift: whatever the diffuse damper is set to, the
 * mirror comes back to 1.0.
 */
const PANEL_ENV_SPEC_RESTORE = 1 / CLEAR_ENV_INTENSITY;
/**
 * THE VEIL — scene-linear radiance the CELL skins ADD, before any blend touches them.
 *
 * It is the one term in this file that does not multiply something else, which is the whole
 * point: a multiplier on `bg − tint` is worth nothing when the ground is the tint's own value,
 * and three passes at this bug were spent finding that out. Un-attenuated by alpha, so it lands
 * at its own value whatever the sheet's transmittance is.
 *
 * 0.085 measured, in scene-linear units ahead of ACES, which is what makes one skin worth about
 * +25 sRGB levels on a dark ground and about +23 on the lit room behind a hive — the same band
 * the MOUTH view already measured, which is the owner's actual complaint stated as a number.
 *
 * ⚠️ AND THE CAP IS SIZED AGAINST THE STACK, NOT AGAINST ONE SKIN. `FrontSide` leaves three of
 * these between the eye and an element when you look into a cell (floor, roof, back) and each
 * one ADDS, so the value that is right on its own is three times too much through the mouth.
 * `PANEL_VEIL_GAIN_MAX` bounds the un-attenuation and ACES' own shoulder does the rest; what is
 * actually held is the MEASUREMENT — a NECTAR seen through the worst stack keeps ≥ 70 % of the
 * luminance spread it has with no panel at all, which the RENDER lane states and the probe in
 * `scripts/scene-preview` measures.
 */
const PANEL_VEIL = 0.018;
/** the veil's own colour: a cool near-white, NOT `CLEAR_PANEL_TINT`. The tint is what the sheet
 *  TRANSMITS; scatter off an abraded surface is the room's own white, slightly cool. */
const PANEL_VEIL_TINT = 0xdfe6ec;
/** how much the veil grows with the sheet's own thickness term — more sheet in the line of sight
 *  scatters more — as a multiple of the face-on value, capped so a grazing skin does not become a
 *  lamp. */
const PANEL_VEIL_GRAZE_MAX = 1.25;
/** ceiling on the un-attenuation the veil is allowed, the same guard `PANEL_SHEEN_MAX` is for the
 *  reflection: a future lower opacity must not divide this by something tiny. */
const PANEL_VEIL_GAIN_MAX = 12;
/**
 * ⚠️ AND THE SHEET HAS THICKNESS, WHICH IS WHAT ACTUALLY DECIDED THIS ONE.
 *
 * Beer–Lambert: a slab whose face-on opacity is `a₀` is traversed over a path `d / |N·V|`, so its
 * opacity off normal is `1 − (1 − a₀)^(1/|N·V|)`. At normal incidence that is EXACTLY `a₀` — the
 * white-board re-tune is still untouched where it was measured — and it rises from there far
 * earlier and far more gently than Schlick's fifth power, which is a REFLECTION term and moves
 * nothing until the last 20° before grazing. Both are real and both are here: the alpha is the
 * larger of the two, capped at `PANEL_GRAZE_OPACITY`.
 *
 * This is the term the first pass's header thought it had. It claimed a slab's 0.020-in side face
 * picks up the grazing alpha and "the panel gets a boundary" — at 78 in, a driver's distance from
 * a hive, that face is 0.03 px wide. It draws nothing. What a sheet seen at an angle actually
 * shows is more sheet, not more edge.
 */
const PANEL_PATH_MIN_COS = 0.05;

/**
 * The same curve the shader runs, in JS, so the RENDER lane can check it without a GL context.
 * `cosTheta` is N·V; `abs` because a panel seen from behind behaves exactly as one seen from in
 * front, which is the whole point of the item this answers.
 */
export function clearPanelAlphaAt(baseOpacity: number, cosTheta: number): number {
  const c = Math.min(1, Math.max(0, Math.abs(cosTheta)));
  // Schlick: R(θ) = F0 + (1 − F0)(1 − cos θ)⁵. What is wanted is the EXCESS over normal
  // incidence, normalized to [0, 1] — (R(θ) − F0) / (1 − F0) — because the measured face-on
  // opacity already accounts for R(0). F0 cancels out of that ratio exactly, leaving (1 − c)⁵;
  // it is written through `PANEL_F0` anyway so the derivation is legible rather than asserted,
  // and the shader's one-line `pow( 1.0 - bbCos, 5.0 )` is this expression reduced.
  const schlick = PANEL_F0 + (1 - PANEL_F0) * (1 - c) ** 5;
  const excess = (schlick - PANEL_F0) / (1 - PANEL_F0);
  const fresnel = baseOpacity + (PANEL_GRAZE_OPACITY - baseOpacity) * excess;
  // ...and the THICKNESS term, which is the one that carries an ordinary off-normal look — see
  // `PANEL_PATH_MIN_COS`. The two are alternative routes to the same photon not getting through,
  // so the alpha is the larger, never their sum, and the graze value is still the ceiling.
  const path = 1 - (1 - baseOpacity) ** (1 / Math.max(c, PANEL_PATH_MIN_COS));
  return Math.min(Math.max(path, fresnel), PANEL_GRAZE_OPACITY);
}

/** the factor the reflected term is scaled by so the alpha multiply does not eat it. */
export function clearPanelSheenGain(alpha: number): number {
  return Math.min(1 / Math.max(alpha, 0.02) - 1, PANEL_SHEEN_MAX);
}

/**
 * The VEIL's scene-linear radiance for one skin at this viewing angle, in the units it lands on
 * the screen in — the shader divides by the alpha the blend is about to multiply by, so what this
 * returns is what the pixel gains, over ANY background. `veil` is the material's own strength
 * (`PANEL_VEIL` for a cell skin, 0 for the perimeter walls).
 *
 * It takes no light and no view direction beyond `cosTheta`, and the RENDER lane asserts exactly
 * that: the term the owner's report needed is the one that cannot be turned off by moving a lamp.
 */
export function clearPanelVeilAt(veil: number, baseOpacity: number, cosTheta: number): number {
  if (veil <= 0) return 0;
  const alpha = clearPanelAlphaAt(baseOpacity, cosTheta);
  // more sheet in the line of sight scatters more, as a multiple of the face-on value
  const thickness = Math.min(alpha / baseOpacity, PANEL_VEIL_GRAZE_MAX);
  const gain = Math.min(1 / Math.max(alpha, 0.02), PANEL_VEIL_GAIN_MAX);
  return veil * thickness * gain * alpha;
}

/**
 * What the panel puts on the screen that does NOT depend on where the key light is, per unit of
 * ambient radiance reaching it — the mirror at its true dielectric strength plus the scuff
 * scatter. The RENDER lane checks this rather than the shader text, because "a face pointing away
 * from every light still reads" is a claim about a NUMBER and the first pass at this bug passed
 * every text check it had while being invisible.
 *
 * `cosTheta` is N·V; `abs` for the same reason `clearPanelAlphaAt` takes it. The two terms are
 * the ones the shader adds un-attenuated, so this is in post-blend screen units directly.
 */
export function clearPanelLightIndependent(
  baseOpacity: number,
  cosTheta: number,
): { mirror: number; body: number; total: number } {
  const alpha = clearPanelAlphaAt(baseOpacity, cosTheta);
  const gain = clearPanelSheenGain(alpha);
  const c = Math.min(1, Math.max(0, Math.abs(cosTheta)));
  // Schlick again — this time for the REFLECTANCE itself, not for the alpha's excess over it.
  const fresnel = PANEL_F0 + (1 - PANEL_F0) * (1 - c) ** 5;
  // MIRROR, per unit of ambient radiance: what `indirectSpecular` already carries into
  // `outgoingLight` (Fresnel, damped by the env intensity) plus the restored copy the shader
  // adds, both multiplied down by the blend's own alpha afterwards.
  const raw = fresnel * CLEAR_ENV_INTENSITY;
  const mirror = alpha * raw + alpha * gain * raw * PANEL_ENV_SPEC_RESTORE;
  // BODY, per unit of the background behind it: what the sheet takes OUT of the ground it is
  // seen against. It is the term that does not care where the light is or how bright the ground
  // is, and against the lit room behind a hive it is the ONLY one left — see the header.
  const body = alpha;
  return { mirror, body, total: mirror + body };
}

/** everything a skin puts on the screen that no light position can take away: the restored
 *  mirror (per unit of ambient radiance), the body it takes out of its background, and — the one
 *  that answers the owner's report — the veil it ADDS regardless of either. */
export function clearPanelPresence(
  veil: number,
  baseOpacity: number,
  cosTheta: number,
): { mirror: number; body: number; veil: number } {
  const { mirror, body } = clearPanelLightIndependent(baseOpacity, cosTheta);
  return { mirror, body, veil: clearPanelVeilAt(veil, baseOpacity, cosTheta) };
}

/**
 * A CEILING ON A CLEAR PANEL'S OUTPUT, raw linear radiance, SHARED by every panel material (one
 * uniform object, so a write reaches all of them with no recompile). Its resting value is far
 * above anything the half-float scene target holds in practice, so the clamp is a no-op and the
 * picture is what it always was.
 *
 * It exists for BLOOM (Extreme, `renderPost.ts`). The sheen above un-attenuates the specular by
 * up to `PANEL_SHEEN_MAX`, and a perimeter wall facing a studio's key light is then a whole
 * wall of pixels at 5–10× the bloom threshold: measured on `monochrome-studio`'s driver view,
 * 0.7 % of the frame, and the blur turned it into a white haze over the far robots. The match
 * scene lowers the cap to HALF the bloom threshold for its own pass while bloom is on and puts
 * it back after (`renderScene.ts`, `BLOOM_PANEL_CAP` in `renderPost.ts` for why half), so a lit
 * panel still reads as a bright sheet and stops feeding the glow.
 */
const PANEL_OUTPUT_CAP_OFF = 1e4;
const PANEL_OUTPUT_CAP = { value: PANEL_OUTPUT_CAP_OFF };
/** set the clear panels' output ceiling (raw linear), or `null` to lift it. See `PANEL_OUTPUT_CAP`. */
export function setClearPanelCap(raw: number | null): void {
  PANEL_OUTPUT_CAP.value = raw ?? PANEL_OUTPUT_CAP_OFF;
}

/** the one clear-plastic material this file builds, for both the perimeter and the cell skins —
 * exported because `scene/renderField.ts`'s constants-built FALLBACK field draws the same
 * polycarbonate and used to build a material of its own, which is how the two paths came to
 * disagree about everything in the dielectric header above. There is one now. */
export function clearPanelMaterial(opacity: number, veil = 0): THREE.Material {
  // the veil is scene-LINEAR, which is the space `outgoingLight` is in — three converts an sRGB
  // hex at read time, so the literal stays a colour a person can read.
  const veilRgb = new THREE.Color().setHex(PANEL_VEIL_TINT, THREE.SRGBColorSpace);
  const mat = new THREE.MeshPhysicalMaterial({
    color: CLEAR_PANEL_TINT,
    metalness: 0,
    roughness: PANEL_ROUGHNESS,
    ior: PANEL_IOR,
    transparent: true,
    opacity,
    depthWrite: false,
    // ⚠️ DoubleSide, AND IT IS NOT A REVERSAL OF THE WHITE-BOARD RE-TUNE. See
    // `CLEAR_SHEETS_ARE_SINGLE_SIDED` — these are SHEETS, so this draws each one ONCE from
    // either side; it is `FrontSide` that was drawing them zero times from one of the two. The
    // constant is the one-word revert for the day the CAD pipeline exports closed slabs.
    side: CLEAR_SHEETS_ARE_SINGLE_SIDED ? THREE.DoubleSide : THREE.FrontSide,
    envMapIntensity: CLEAR_ENV_INTENSITY,
  });
  // ⚠️ THE HOOK IS KEYED, or three caches one program for every panel and the second material to
  // compile gets the first one's chunk. `customProgramCacheKey` is how that is declared.
  mat.customProgramCacheKey = () =>
    `bb-clear-panel|${PANEL_GRAZE_OPACITY}|${PANEL_SHEEN_MAX}|${PANEL_ENV_SPEC_RESTORE}|${PANEL_PATH_MIN_COS}|${veil}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.bbPanelCap = PANEL_OUTPUT_CAP;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', 'uniform float bbPanelCap;\n#include <common>');
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      [
        // `normal` and `vViewPosition` are both in scope here (they are what the lighting was
        // just evaluated from), and `reflectedLight` still holds the split terms.
        `float bbCos = max( abs( dot( normalize( normal ), normalize( vViewPosition ) ) ), ${PANEL_PATH_MIN_COS.toFixed(2)} );`,
        'float bbExcess = pow( 1.0 - bbCos, 5.0 );',
        // the two routes a photon fails to get through: more SHEET at an angle (Beer–Lambert,
        // the term that carries an ordinary look) and more REFLECTION near grazing (Schlick,
        // which moves nothing until the last 20 degrees). The larger, never the sum.
        'float bbPath = 1.0 - pow( 1.0 - diffuseColor.a, 1.0 / bbCos );',
        `float bbFresnel = mix( diffuseColor.a, ${PANEL_GRAZE_OPACITY.toFixed(4)}, bbExcess );`,
        `diffuseColor.a = min( max( bbPath, bbFresnel ), ${PANEL_GRAZE_OPACITY.toFixed(4)} );`,
        // ⚠️ `indirectSpecular` is the ROOM, and `envMapIntensity` has already taken 85 % of it
        // off — see the dielectric header. Put it back HERE, where it is the mirror, not up in
        // the material, where it would also un-damp the irradiance that turned the sheet beige.
        `vec3 bbSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular * ${PANEL_ENV_SPEC_RESTORE.toFixed(4)};`,
        `outgoingLight += bbSpec * min( 1.0 / max( diffuseColor.a, 0.02 ) - 1.0, ${PANEL_SHEEN_MAX.toFixed(1)} );`,
        // ⚠️ THE VEIL — the only term here that ADDS rather than multiplying a difference, which
        // is why it is the one that works on a mid-tone ground. Light-independent and
        // view-independent by construction; the `/ alpha` is the blend's own multiply, undone.
        ...(veil > 0
          ? [
              `float bbVeilT = min( diffuseColor.a / max( ${opacity.toFixed(4)}, 0.001 ), ${PANEL_VEIL_GRAZE_MAX.toFixed(2)} );`,
              `float bbVeilG = min( 1.0 / max( diffuseColor.a, 0.02 ), ${PANEL_VEIL_GAIN_MAX.toFixed(1)} );`,
              `outgoingLight += vec3( ${veilRgb.r.toFixed(4)}, ${veilRgb.g.toFixed(4)}, ${veilRgb.b.toFixed(4)} ) * ${veil.toFixed(4)} * bbVeilT * bbVeilG;`,
            ]
          : []),
        // the bloom ceiling (`PANEL_OUTPUT_CAP`), a no-op at its resting value. Divided by alpha
        // because the blend multiplies by it: what is capped is the panel's share ON SCREEN, so a
        // capped sheet lands at the threshold and not a third of it (the first spelling capped
        // the pre-blend value and the lit wall went visibly grey under bloom).
        'outgoingLight = min( outgoingLight, vec3( bbPanelCap / max( diffuseColor.a, 0.02 ) ) );',
        '#include <opaque_fragment>',
      ].join('\n'),
    );
  };
  return mat;
}

/** ⚠️ THE TWO CLEAR SURFACES THIS GAME HAS, AND THE ONLY TWO PLACES EITHER IS BUILT. They differ
 * in exactly two numbers and both are load-bearing: a CELL skin is denser than the perimeter, and
 * a CELL skin carries the VEIL while a wall does not (see `PANEL_VEIL`). Anything that wants a
 * clear panel calls one of these — including `scene/renderField.ts`'s fallback field, which used
 * to build its own and drifted. */
export function cellPanelMaterial(): THREE.Material {
  return clearPanelMaterial(CELL_PANEL_OPACITY, PANEL_VEIL);
}
export function wallPanelMaterial(): THREE.Material {
  return clearPanelMaterial(WALL_PANEL_OPACITY);
}

/** the tape and the AprilTag/sticker decals are painted ON a surface that is already there (the
 * tiles, the hive's skins), 0.010 in proud of it. At a driver camera's depth precision that is
 * inside the z-fighting band, so they are drawn with a polygon offset instead of being nudged
 * geometrically — moving the geometry would put the picture and the CAD out of step, which is
 * the whole class of bug this pass exists to remove. */
const DECAL_POLYGON_OFFSET = -2;

/** the top-level GLB node a mesh hangs off — the second half of the clear-plastic key above. */
type NodeFamily = 'tiles' | 'walls' | 'tape' | 'stations' | 'hive_tray' | 'hive_frame' | 'flower' | 'other';

function nodeFamilyOf(name: string | undefined): NodeFamily | null {
  if (!name) return null;
  if (name === 'tiles' || name === 'walls' || name === 'tape' || name === 'stations') return name;
  if (/^hive_(red|blue)\/tray$/.test(name)) return 'hive_tray';
  if (/^hive_(red|blue|shared)\/frame$/.test(name)) return 'hive_frame';
  if (/^flower_\d+$/.test(name)) return 'flower';
  return null;
}

/** TRUE for the parts that are clear polycarbonate on the real field — see the policy header. */
function isClearPanel(finish: Finish, colorHex: number, family: NodeFamily): boolean {
  if (finish === 'glass') return true;
  return finish === 'plastic' && colorHex === 0xe6e6e6 && family === 'hive_tray';
}

function materialFor(finish: Finish, rawHex: number, family: NodeFamily): THREE.Material {
  if (isClearPanel(finish, rawHex, family)) {
    return finish === 'glass' ? wallPanelMaterial() : cellPanelMaterial();
  }
  // the clear-panel test reads the CAD's own value; everything painted below reads the corrected
  // one — see `ALLIANCE_BLUE_TINT`.
  const colorHex = rawHex === CAD_ALLIANCE_BLUE ? ALLIANCE_BLUE_TINT : rawHex;
  switch (finish) {
    case 'glass':
      // unreachable while `isClearPanel` claims every `glass`; kept so the switch stays total
      return wallPanelMaterial();
    case 'metal':
      return new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.7, roughness: 0.35 });
    case 'plastic':
      return new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.05, roughness: 0.5 });
    case 'tape':
      return new THREE.MeshStandardMaterial({
        color: colorHex,
        metalness: 0,
        roughness: 0.8,
        polygonOffset: true,
        polygonOffsetFactor: DECAL_POLYGON_OFFSET,
        polygonOffsetUnits: DECAL_POLYGON_OFFSET,
      });
    case 'decal':
      return new THREE.MeshStandardMaterial({
        color: colorHex,
        metalness: 0,
        roughness: 0.85,
        polygonOffset: true,
        polygonOffsetFactor: DECAL_POLYGON_OFFSET,
        polygonOffsetUnits: DECAL_POLYGON_OFFSET,
      });
    case 'tile':
      return new THREE.MeshStandardMaterial({ color: TILE_TONE, metalness: 0, roughness: 0.9 });
    case 'misc':
    default:
      return new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.2, roughness: 0.6 });
  }
}

/**
 * ⚠️ `computeVertexNormals()` IS THE WRONG PASS FOR THIS ASSET, AND IT IS WHAT PUT WHITE
 * ARTIFACTS ON THE BLACK BRACKETS (owner bug 4, 2026-09-19: "all of the black linking components
 * that hold the support beams of the center structure are rendered weirdly — it looks like it has
 * white artifacts").
 *
 * Neither GLB carries a `NORMAL` attribute, and that is deliberate (`assemble-gltf.mjs`'s header:
 * flat per-triangle normals stop meshoptimizer collapsing any edge on a mesh built from many
 * merged parts). So the loader has to compute them — and it computed them SMOOTH, over a soup in
 * which every part of a hive frame sharing one CAD colour is one welded primitive. Measured on
 * the shipped `field.glb`:
 *
 * | mesh | tris | triangles with a vertex normal > 45° off the face | zero-length normals |
 * |---|---|---|---|
 * | `hive_red/frame` `metal#303030` | 19,674 | 71 % | 0 |
 * | `hive_blue/frame` `metal#303030` | 19,672 | 71 % | 3 |
 * | `walls` `metal#303030` | 18,480 | 64 % | 12 |
 * | `flower_*` `metal#303030` | 1,332 | 75 % | 0 |
 *
 * Worst case 180°: a vertex where two parts meet back to back averages to nothing, `normalize()`
 * of a zero vector is NaN, and the shader's specular term goes undefined. It shows up on the BLACK
 * parts first because `metal` is `metalness: 0.7` — on a `#303030` base the reflection IS the
 * picture, so a wrong normal samples the bright environment and the bracket flashes white.
 *
 * This is the same pass with a CREASE ANGLE: a corner's normal averages only the faces around
 * that vertex within `creaseDeg` OF ITS OWN, so a box corner keeps three hard normals while a
 * tessellated cylinder stays round. Measured on `field.glb`: 63–75 % of triangles over-smoothed
 * before and **0.07 %** after — 141 triangles out of 208,172, every one of them a sliver of under
 * 1.5e-11 in² that covers no pixel at any camera — with 0 degenerate normals, in 149 ms once at
 * load.
 *
 * ⚠️ THE GROUPING IS PER CORNER AND IS NOT TRANSITIVE, AND THAT IS THE WHOLE TRICK. The first
 * version union-found a vertex's faces into smoothing GROUPS, which is the obvious reading of
 * "group by angle" and is wrong on exactly the shape this field is full of: on a 12-sided
 * tessellated cylinder every face is 30° from its neighbour, so at a 40° crease the union chains
 * all the way round the ring, one group spans 360°, and its area-weighted average is the ZERO
 * VECTOR. It took the over-smoothed count from 68 % to 7.5 % and left the worst case at a full
 * 180° — the same artifact, just rarer. Per corner there is nothing to chain: each one averages
 * itself plus its two neighbours and comes out normal to the ring.
 *
 * It keeps the INDEX, deduplicating corners that agree on a normal. Three's own
 * `BufferGeometryUtils.toCreasedNormals` (which does the same per-corner average) de-indexes
 * instead — 624,516 vertices on this field against the 243,547 the dedupe needs.
 *
 * ⚠️ EVERY ATTRIBUTE IS COPIED THROUGH `getX/getY/getZ/getW`, for the `KHR_mesh_quantization`
 * reason `partitionTrianglesWorld` documents below.
 */
export const CREASE_ANGLE_DEG = 40;

/** exported for the RENDER lane, which runs it over the real `field.glb` in Node. */
export function computeCreasedNormals(geo: THREE.BufferGeometry, creaseDeg: number): void {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  // a NON-indexed geometry already has one vertex per corner, so the plain pass is exact there.
  if (!index || !pos) {
    geo.computeVertexNormals();
    return;
  }
  const triCount = index.count / 3;
  const vertCount = pos.count;
  const faceN = new Float32Array(triCount * 3);
  const faceArea = new Float32Array(triCount);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, index.getX(t * 3));
    b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
    e1.subVectors(c, b);
    e2.subVectors(a, b);
    e1.cross(e2);
    const twiceArea = e1.length();
    faceArea[t] = twiceArea / 2;
    if (twiceArea > 0) e1.divideScalar(twiceArea);
    faceN[t * 3] = e1.x;
    faceN[t * 3 + 1] = e1.y;
    faceN[t * 3 + 2] = e1.z;
  }

  // vertex -> incident corners, as CSR (one array of 100k sub-arrays is the slow way to say this)
  const start = new Uint32Array(vertCount + 1);
  for (let i = 0; i < index.count; i++) start[index.getX(i) + 1]++;
  for (let v = 0; v < vertCount; v++) start[v + 1] += start[v];
  const cursor = start.slice(0, vertCount);
  const incFace = new Uint32Array(index.count);
  const incCorner = new Uint32Array(index.count);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const slot = cursor[index.getX(t * 3 + k)]++;
      incFace[slot] = t;
      incCorner[slot] = t * 3 + k;
    }
  }

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const newIndex = new Uint32Array(index.count);
  const srcOf: number[] = [];
  const outN: number[] = [];
  /** corners of one vertex whose normals agree to within this dot share an output vertex — a
   * vertex has a handful of corners, so the scan is cheaper than hashing 624 k strings. */
  const SAME_NORMAL_DOT = 1 - 1e-6;
  const mine: number[] = [];
  for (let v = 0; v < vertCount; v++) {
    const lo = start[v];
    const hi = start[v + 1];
    if (lo === hi) {
      // an unreferenced vertex: keep it (the index never names it) so every attribute stays aligned
      srcOf.push(v);
      outN.push(0, 0, 1);
      continue;
    }
    mine.length = 0;
    for (let i = lo; i < hi; i++) {
      const fi = incFace[i] * 3;
      // ⚠️ A DEGENERATE FACE HAS NO NORMAL, AND `KHR_mesh_quantization` MAKES THEM: snapping a
      // position to the 16-bit grid collapses a sliver to zero area. Its own dot with anything is
      // 0, so an angle test would exclude every face INCLUDING itself and leave the corner with a
      // zero-length normal — the exact defect this function exists to remove. Such a corner takes
      // the flat average of the vertex's real faces instead; the triangle draws no pixels either
      // way, but nothing leaves here un-normalised.
      const flat = faceArea[incFace[i]] === 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let j = lo; j < hi; j++) {
        const f = incFace[j];
        const w = faceArea[f];
        if (w === 0) continue;
        const fj = f * 3;
        if (!flat) {
          const dot = faceN[fi] * faceN[fj] + faceN[fi + 1] * faceN[fj + 1] + faceN[fi + 2] * faceN[fj + 2];
          if (dot < cosCrease) continue;
        }
        nx += faceN[fj] * w;
        ny += faceN[fj + 1] * w;
        nz += faceN[fj + 2] * w;
      }
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nz = 1;
      }
      let out = -1;
      for (const cand of mine) {
        if (outN[cand * 3] * nx + outN[cand * 3 + 1] * ny + outN[cand * 3 + 2] * nz >= SAME_NORMAL_DOT) {
          out = cand;
          break;
        }
      }
      if (out < 0) {
        out = srcOf.length;
        mine.push(out);
        srcOf.push(v);
        outN.push(nx, ny, nz);
      }
      newIndex[incCorner[i]] = out;
    }
  }

  const outCount = srcOf.length;
  const normals = Float32Array.from(outN);
  const get = (src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, k: number): number =>
    k === 0 ? src.getX(i) : k === 1 ? src.getY(i) : k === 2 ? src.getZ(i) : src.getW(i);
  for (const name of Object.keys(geo.attributes)) {
    const src = geo.getAttribute(name);
    const size = src.itemSize;
    const dst = new Float32Array(outCount * size);
    for (let i = 0; i < outCount; i++) {
      const s = srcOf[i];
      for (let k = 0; k < size; k++) dst[i * size + k] = get(src, s, k);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(dst, size));
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1));
}

/** `<finish>#<rrggbb>` -> `{finish, colorHex}`; `null` for anything that is not in that shape. */
function parseMaterialName(name: string | undefined): { finish: Finish; colorHex: number } | null {
  if (!name) return null;
  const cut = name.indexOf('#');
  if (cut <= 0) return null;
  const finish = name.slice(0, cut) as Finish;
  if (!(FINISHES as readonly string[]).includes(finish)) return null;
  const hex = name.slice(cut + 1);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return { finish, colorHex: parseInt(hex, 16) };
}

/**
 * Assigns each mesh's runtime PBR material from ITS OWN GLTF MATERIAL NAME (`obj.material.name`,
 * preserved by GLTFLoader) and turns on shadows. One THREE material per distinct name, shared
 * across every mesh that carries it.
 *
 * The assembled glb ships NO vertex normals (see `assemble-gltf.mjs`'s header — meshoptimizer's
 * simplifier cannot collapse a flat-shaded mesh's edges, since every triangle boundary then looks
 * like a hard attribute seam), so this also computes them once here — CREASED, never smooth; see
 * `computeCreasedNormals`, whose header carries the measurement that made it necessary.
 *
 * ⚠️ THE CACHE KEY IS `<material>@<node family>`, NOT THE MATERIAL NAME. One glTF material name
 * can want two different surfaces — `plastic#e6e6e6` is a clear CELL skin in a tray node and an
 * opaque ACM logo board in the shared frame — so keying on the name alone hands whichever node
 * loads first its answer to both. See the clear-plastic policy header.
 */
function styleScene(root: THREE.Object3D): void {
  const cache = new Map<string, THREE.Material>();
  const unknown = new Set<string>();
  const walk = (obj: THREE.Object3D, family: NodeFamily): void => {
    const own = nodeFamilyOf((obj.userData as { name?: string } | undefined)?.name ?? obj.name);
    const here = own ?? family;
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      // the four flower nodes share ONE geometry, so the guard is what keeps this to one pass
      if (obj.geometry && !obj.geometry.getAttribute('normal')) {
        computeCreasedNormals(obj.geometry, CREASE_ANGLE_DEG);
      }
      const src = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const name = src?.name;
      const parsed = parseMaterialName(name);
      const key = `${parsed ? name : '__unrecognised__'}@${here}`;
      let mat = cache.get(key);
      if (!mat) {
        if (!parsed) unknown.add(String(name));
        mat = parsed ? materialFor(parsed.finish, parsed.colorHex, here) : materialFor('misc', 0x9aa1ab, here);
        mat.name = key; // debuggable from a console walk of the live scene; nothing reads it
        cache.set(key, mat);
      }
      obj.material = mat;
      if (parsed?.finish === 'tile') obj.castShadow = false; // the floor never casts, only receives
      if (parsed && isClearPanel(parsed.finish, parsed.colorHex, here)) {
        // a clear panel casts no shadow: a see-through sheet that throws a solid black shadow is
        // the single most obvious way to say "this is not actually transparent".
        obj.castShadow = false;
        obj.renderOrder = parsed.finish === 'glass' ? WALL_RENDER_ORDER : CELL_RENDER_ORDER;
      }
    }
    for (const child of obj.children) walk(child, here);
  };
  walk(root, 'other');
  if (unknown.size > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `renderFieldGlb: ${unknown.size} glTF material name(s) are not "<finish>#<rrggbb>" and fell back to grey: ` +
        `${[...unknown].join(', ')}. Regenerate with \`npm run field-cad\`, or add the finish to FINISHES here and to FINISH in assemble-gltf.mjs.`,
    );
  }
}

/** builds the pivot-anchored tray group for one alliance — see `FieldHiveGroup.tray`'s header. */
function buildTrayGroup(root: THREE.Object3D, alliance: Alliance): THREE.Group {
  const rawTray = mustFind(root, `hive_${alliance}/tray`);
  const pivot = fieldColliders3d().trays[alliance].pivot;
  const pivotGroup = new THREE.Group();
  pivotGroup.name = `hive_${alliance}/tray-pivot`;
  pivotGroup.position.set(pivot[0], pivot[1], pivot[2]);
  // the pivot group must share rawTray's CURRENT parent for `attach()` to compute a correct
  // relative offset (attach() reads the object's current world matrix, which needs an
  // up-to-date parent chain) — add it as a sibling first, then reparent.
  rawTray.parent?.add(pivotGroup);
  pivotGroup.attach(rawTray);
  return pivotGroup;
}

// ── THE TRAY BRACES THE PIPELINE FILED AS FRAME ───────────────────────────────────────────────
//
// 2026-09-18 playtest: "some weird lines remain after the HIVE is tipped."
//
// `convert.py`'s PART_RULES sends `am-5867: 10.5in Churro Lite` to `hive_frame` (STATIC), but all
// EIGHT of them ride the TRAY: un-tilting each one by its alliance's own `captureTheta` about the
// pivot collapses it to a segment at a constant tray-local `w ≈ 6.2` (the floor/roof seam) and
// `|x_local| ≈ 9.5` (the cell's two sides), running the cell's full depth `|v| 10.05 … 20.84` —
// measured off `field-colliders.json`'s own per-instance hulls. A static part could not sit at
// ±30° in a mirrored pair like that. So the GLB bakes them into the frame node at the captured
// pose, and when the tray swings they stay: four 10.5-in tubes 0.37 in wide, left hanging in the
// air. They are exactly the "weird lines".
//
// THE REAL FIX IS ONE LINE IN `PART_RULES`, and it is not made here: re-running `npm run field-cad`
// rewrites the GLBs, `field-colliders.json` and `fieldColliders.gen.ts`, which moves a physics
// static into the kinematic tray. That is a sim change and it is not this lane's. This reparents
// them at load instead, and is a no-op on a future asset that files them correctly (the selector
// simply finds nothing).
//
// THE SELECTOR is world-space and stated as measurements, because the braces are merged into one
// triangle soup per material and there is no name left to ask:
//  - nothing else in a hive FRAME node reaches z 46: the tallest static part is the Goal Pivot
//    Bracket at 45.70, and the raised pair of braces spans 54.27 … 59.85.
//  - the lowered pair spans z 38.83 … 44.40 at |y| 11.85 … 21.11, and at |y| ≥ 11.5 the only other
//    frame part with any material is the A-Frame Leg — a diagonal strut from its foot (|y| 19.07,
//    z 0.22) to the apex (y 0, z 41.40), which at |y| = 11.5 is down at z ≈ 16.
const BRACE_HIGH_Z = 46;
const BRACE_MIN_ABS_Y = 11.5;
const BRACE_MIN_Z = 36;

function isTrayBracePoint(y: number, z: number): boolean {
  return z >= BRACE_HIGH_Z || (Math.abs(y) >= BRACE_MIN_ABS_Y && z >= BRACE_MIN_Z);
}

/**
 * Partitions `mesh`'s triangles by a WORLD-space test on each triangle's centroid: each labelled
 * group comes back as a new geometry already baked into WORLD coordinates, and `mesh` is left
 * with everything `classify` returned `null` for. One pass, not one per label — a second pass
 * over a mesh this has already rewritten would read back what it wrote, which is how the first
 * version of this produced coordinates in the millions.
 *
 * ⚠️ EVERY ATTRIBUTE IS COPIED THROUGH `getX/getY/getZ/getW`, NEVER OFF `.array`. The field GLB
 * uses `KHR_mesh_quantization`, so a position attribute is a NORMALIZED Int16Array and its raw
 * array holds counts, not inches: copying the buffer verbatim into a plain Float32Array is the
 * bug just described, and it is silent until you look at a bounding box.
 */
function partitionTrianglesWorld(
  mesh: THREE.Mesh,
  classify: (cx: number, cy: number, cz: number, tri: number) => string | null,
): Map<string, THREE.BufferGeometry> {
  const out = new Map<string, THREE.BufferGeometry>();
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return out;
  mesh.updateWorldMatrix(true, false);
  const v = new THREE.Vector3();
  const worldPos = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    worldPos[i * 3] = v.x;
    worldPos[i * 3 + 1] = v.y;
    worldPos[i * 3 + 2] = v.z;
  }
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const groups = new Map<string, number[]>();
  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const cx = (worldPos[a * 3] + worldPos[b * 3] + worldPos[c * 3]) / 3;
    const cy = (worldPos[a * 3 + 1] + worldPos[b * 3 + 1] + worldPos[c * 3 + 1]) / 3;
    const cz = (worldPos[a * 3 + 2] + worldPos[b * 3 + 2] + worldPos[c * 3 + 2]) / 3;
    const label = classify(cx, cy, cz, t);
    if (label === null) {
      kept.push(a, b, c);
    } else {
      const bucket = groups.get(label);
      if (bucket) bucket.push(a, b, c);
      else groups.set(label, [a, b, c]);
    }
  }
  if (groups.size === 0) return out;

  const names = Object.keys(geo.attributes);
  const get = (src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, k: number): number =>
    k === 0 ? src.getX(i) : k === 1 ? src.getY(i) : k === 2 ? src.getZ(i) : src.getW(i);
  const rebuild = (order: number[], world: boolean): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const name of names) {
      const src = geo.getAttribute(name);
      const size = src.itemSize;
      const dst = new Float32Array(order.length * size);
      for (let i = 0; i < order.length; i++) {
        const s = order[i];
        if (world && name === 'position') {
          dst[i * 3] = worldPos[s * 3];
          dst[i * 3 + 1] = worldPos[s * 3 + 1];
          dst[i * 3 + 2] = worldPos[s * 3 + 2];
        } else {
          for (let k = 0; k < size; k++) dst[i * size + k] = get(src, s, k);
        }
      }
      g.setAttribute(name, new THREE.BufferAttribute(dst, size));
    }
    // the same pass the rest of the field gets. `rebuild` emits a NON-indexed geometry (one
    // vertex per corner), so this resolves to flat per-face normals — right for a 0.37-in churro
    // and, more to the point, the one normal pass in this file stays the one function.
    if (!g.getAttribute('normal')) computeCreasedNormals(g, CREASE_ANGLE_DEG);
    return g;
  };

  for (const [label, order] of groups) out.set(label, rebuild(order, true));
  const keptGeo = rebuild(kept, false);
  geo.dispose();
  mesh.geometry = keptGeo;
  return out;
}

// ── THE PIVOT ROCKER THE PIPELINE ALSO FILED AS FRAME ─────────────────────────────────────────
//
// 2026-09-20 playtest: "Support bracket for the hive is artifacting & is behind/desynced
// sometimes (does not tip with the hive)."
//
// The braces above were not the only tray parts in a FRAME node. SIX MORE per alliance ride the
// see-saw and are filed static: `am-5872 Goal Pivot Bracket` ×2 (the plates the owner's "support
// bracket" names — they sandwich the tray's own `Basket Base Tube` spine), `am-5874 Pivot Damper
// Holder` ×2 and `blumotion-970a Damper` ×2. The proof is the hive's OWN SYMMETRY: every part of
// this assembly is mirror-symmetric about y = 0 in whichever body it is rigid in, and these six
// are symmetric only AFTER un-tilting. Measured off `field-colliders.json`'s per-instance hulls,
// blue (`captureTheta` +30°):
//
//   | part | world y centre | tray-local v, w after un-tilt |
//   |---|---|---|
//   | goal_pivot_bracket ×2   | +1.10 (NOT 0)     | v **0.01**, w −0.92 — self-symmetric |
//   | pivot_damper_holder     | +3.57             | v **+3.34**, w −1.31 |
//   | pivot_damper_holder_2   | −2.15             | v **−3.34**, w −1.24 |
//   | blumotion_damper        | −1.94             | v **−3.21**, w **−1.62** |
//   | blumotion_damper_2      | +3.47             | v **+3.16**, w **−1.62** |
//
// Red's six sit at DIFFERENT world y and z and land on the same tray-local numbers. A static part
// of a symmetric frame cannot do that; every genuinely static part here already is symmetric in
// world (`a_frame_leg` ±9.5, `frame_foot` ±18.3, `axle_holder`/`a_frame_top_corner`/`top_bar` at 0).
//
// WHAT THE OWNER SEES IS ONE FACT SEEN TWICE. `|captureTheta|` IS `BB_HIVE_TILT_DEG` (30°), so at
// the rest pose the tray was exported at, the frozen rocker is exactly where it belongs and the
// picture is right — which is the "sometimes". Away from it the assembly is left behind: measured
// against where it belongs, **0.00 in at the captured rest, 3.77 in level, 7.28 in at the OTHER
// rest**, and between the two its arms sweep straight THROUGH the tray arms and into the cell,
// which is the "artifacting". Ruled out as separate causes, on the shipped `field.glb`: bad
// normals (the creased pass leaves 3–4 triangles per hive-frame mesh over 45°, all sub-pixel
// slivers), open sheeting (two-faced fraction 0.004–0.094, the same band as the solid A-frame leg
// and the churro tubes, so `DoubleSide` is not wanted and `isClearPanel` never claims them), and
// z-fighting anywhere but the captured rest, where the CAD genuinely bolts the plates face-to-face
// against the spine.
//
// THE REAL FIX IS AGAIN ONE LINE IN `convert.py`'s `PART_RULES`; the reasoning for not making it
// here is `reparentTrayBraces`'s above, unchanged.
//
// ⚠️ THE SELECTOR CANNOT BE A TRIANGLE-CENTROID TEST LIKE THE BRACES'. The braces are alone in
// their corner of space; the rocker is not. Everything in it lies within 0.60 in of the tray's own
// centreline plane (it bolts to a single central spine), but `a_frame_top_corner` straddles that
// plane and `a_frame_leg` starts 0.45 in from it, so a per-triangle test slices pieces out of two
// static parts. A WHOLE CONNECTED COMPONENT is the unit: the rocker's six reach at most 0.60 in
// from the pivot plane and the nearest static component reaches 2.24, on both GLBs.
//
// The constants-built fallback (`renderField.ts`'s `buildHiveFrame`) needs nothing: its frame is a
// base bar and two uprights, and it models no pivot hardware at all.
const ROCKER_HALF_SPAN_IN = 1.25;

/**
 * The connected components of `mesh`, welded by EXACT vertex POSITION, with each one's reach in
 * WORLD x. Used to decide whole parts rather than triangles — see the block above.
 *
 * ⚠️ WELDING BY INDEX IS WRONG HERE, and the reason is a fix three headers up.
 * `computeCreasedNormals` splits a vertex into one output per distinct normal, so once it has run
 * a plain box is six index-disjoint quads and a union-find over the index buffer calls one part
 * six components. Those split copies carry the position through verbatim, bit for bit, so welding
 * on the position triple recovers exactly the topology the asset shipped with — no tolerance, and
 * none needed. 12–20 ms over all eight hive-frame meshes of `field.glb`, once at load, beside the
 * 149 ms the normal pass already costs there.
 */
/** exported for the RENDER lane, which needs to enumerate hive-frame components from the shipped
 *  GLB the same way `hiveFrameComponents`/`reparentTrayBraces` do — a re-implementation could
 *  agree with a wrong belief about the topology instead of measuring the real one. */
export function weldedComponents(
  mesh: THREE.Mesh,
): { ofTriangle: Int32Array; spans: Map<number, { tris: number; xMin: number; xMax: number; zMin: number; zMax: number }> } {
  const { tri, triCount, siteCount, sitePos } = weldTriangles(mesh.geometry);
  const ofTriangle = new Int32Array(triCount).fill(-1);
  const spans = new Map<number, { tris: number; xMin: number; xMax: number; zMin: number; zMax: number }>();
  if (triCount === 0) return { ofTriangle, spans };
  mesh.updateWorldMatrix(true, false);
  const v = new THREE.Vector3();
  const worldX = new Float64Array(siteCount);
  const worldZ = new Float64Array(siteCount);
  for (let s = 0; s < siteCount; s++) {
    v.set(sitePos[s * 3], sitePos[s * 3 + 1], sitePos[s * 3 + 2]).applyMatrix4(mesh.matrixWorld);
    worldX[s] = v.x;
    worldZ[s] = v.z;
  }
  const root = vertexComponents(tri, triCount, siteCount);
  for (let t = 0; t < triCount; t++) {
    const r = root[t];
    ofTriangle[t] = r;
    let s = spans.get(r);
    if (!s) {
      s = { tris: 0, xMin: Infinity, xMax: -Infinity, zMin: Infinity, zMax: -Infinity };
      spans.set(r, s);
    }
    s.tris++;
    for (let k = 0; k < 3; k++) {
      const rr = tri[t * 3 + k];
      const x = worldX[rr];
      const z = worldZ[rr];
      if (x < s.xMin) s.xMin = x;
      if (x > s.xMax) s.xMax = x;
      if (z < s.zMin) s.zMin = z;
      if (z > s.zMax) s.zMax = z;
    }
  }
  return { ofTriangle, spans };
}

/**
 * The weld itself, split out of `weldedComponents` so the winding repair below and the component
 * passes above share ONE welder rather than each carrying a copy of it. Triangles come back as
 * triples of WELDED SITE ids, in the geometry's own LOCAL frame; a caller that needs world
 * coordinates transforms the `siteCount` sites, not the `pos.count` vertices.
 *
 * ⚠️ A NON-INDEXED GEOMETRY IS GIVEN AN IDENTITY INDEX FIRST. The winding repair rewrites the
 * index and nothing else, which is what makes it free of attribute copying; the shipped asset is
 * indexed, and this is the guard for one that is not.
 */
function weldTriangles(geo: THREE.BufferGeometry): {
  tri: Int32Array;
  triCount: number;
  siteCount: number;
  sitePos: Float64Array;
} {
  const pos = geo.getAttribute('position');
  if (!pos) return { tri: new Int32Array(0), triCount: 0, siteCount: 0, sitePos: new Float64Array(0) };
  if (!geo.getIndex()) {
    const ident = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) ident[i] = i;
    geo.setIndex(new THREE.BufferAttribute(ident, 1));
  }
  const idx = geo.getIndex()!;
  const triCount = Math.floor(idx.count / 3);
  const site = new Map<string, number>();
  const rep = new Int32Array(pos.count);
  const px: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x},${y},${z}`;
    let r = site.get(key);
    if (r === undefined) {
      r = site.size;
      site.set(key, r);
      px.push(x, y, z);
    }
    rep[i] = r;
  }
  const tri = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount * 3; t++) tri[t] = rep[idx.getX(t)];
  return { tri, triCount, siteCount: site.size, sitePos: Float64Array.from(px) };
}

/** union-find over welded sites; returns each triangle's component root. */
function vertexComponents(tri: Int32Array, triCount: number, siteCount: number): Int32Array {
  const parent = new Int32Array(siteCount);
  for (let i = 0; i < siteCount; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(tri[t * 3]);
    const b = find(tri[t * 3 + 1]);
    const c = find(tri[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    if (find(c) !== find(a)) parent[find(c)] = find(a);
  }
  const out = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) out[t] = find(tri[t * 3]);
  return out;
}

/** one connected part of a hive FRAME node, and how far it reaches from the NEARER tray's
 *  centreline plane. Exported for the RENDER lane, which parses the shipped GLBs in Node and has
 *  no `loadFieldGlb` to call. */
export interface HiveFrameComponent {
  node: string;
  material: string;
  tris: number;
  alliance: Alliance;
  /** `max |x − pivot.x|` over the component's own vertices — `≤ ROCKER_HALF_SPAN_IN` means it
   *  bolts to that tray's spine and rides it. */
  spanFromPivot: number;
  rides: boolean;
}

/** every connected component of the three hive FRAME nodes, classified. */
export function hiveFrameComponents(root: THREE.Object3D): HiveFrameComponent[] {
  const pivots = trayPivotX();
  const out: HiveFrameComponent[] = [];
  for (const node of HIVE_FRAME_NODES) {
    const obj = findOptional(root, node);
    if (!obj) continue;
    obj.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const material = (Array.isArray(o.material) ? o.material[0] : o.material)?.name ?? '';
      for (const s of weldedComponents(o).spans.values()) {
        const red = Math.max(Math.abs(s.xMin - pivots.red), Math.abs(s.xMax - pivots.red));
        const blue = Math.max(Math.abs(s.xMin - pivots.blue), Math.abs(s.xMax - pivots.blue));
        const alliance: Alliance = red < blue ? 'red' : 'blue';
        const spanFromPivot = Math.min(red, blue);
        out.push({ node, material, tris: s.tris, alliance, spanFromPivot, rides: spanFromPivot <= ROCKER_HALF_SPAN_IN });
      }
    });
  }
  return out;
}

export const HIVE_FRAME_NODES = ['hive_red/frame', 'hive_blue/frame', 'hive_shared/frame'] as const;

function trayPivotX(): Record<Alliance, number> {
  return { red: fieldColliders3d().trays.red.pivot[0], blue: fieldColliders3d().trays.blue.pivot[0] };
}

// ── IT IS NOT THE GROUND BARS. THE WHOLE ASSET IS WOUND AT RANDOM, AND `FrontSide` DELETES ABOUT
//    HALF OF EVERY PART ON THIS FIELD ─────────────────────────────────────────────────────────
//
// owner report 2026-09-21: "a lot of mounting brackets, especially black and gray ones with
// complex geometry, have holes in them from different angles and they are glitchy and broken."
//
// This block used to be `fixGroundBeamWinding` — a `DoubleSide` patch over three named parts
// (`am-5878 Sheet Metal Foot Bar`, `am-5879 Frame Foot`, `am-5880 Under Tile Bar`), selected by a
// z-band, written for the 2026-09-20 report "the structural beams on the ground are rendered as
// transparent on one side and opaque on the other". That report was true and the patch worked. The
// DIAGNOSIS was three parts too small: those bars are not special, they are just the three the
// owner happened to be standing next to.
//
// MEASURED over EVERY mesh and EVERY welded connected component of both shipped GLBs
// (`scratch/bracket-winding.ts`), `field.glb`:
//
//   | class                                        | comps | tris    | share |
//   |---|---|---|---|
//   | closed, consistently wound, facing OUT (fine)| 0     | 0       | 0 %   |
//   | closed, consistently wound, INVERTED         | 1     | 12      | 0.0 % |
//   | closed, MIXED winding inside one shell       | 193   | 268,880 | 100 % |
//   | genuinely OPEN sheeting                      | 0     | 0       | 0 %   |
//
// **Not one component of the high-detail field is correctly wound, and not one of them is open
// sheeting either.** Every part is a closed shell — 0 boundary edges across all 268,892 triangles
// — whose faces are wound in no consistent direction. Propagating orientation across shared edges
// and then turning each shell outward by its own signed volume REVERSES **132,190 of 268,892
// triangles (49.2 %)**, and 193 of 193 shells are orientable, so nothing here is a Möbius strip or
// a genuine modelling error: it is an exporter that never fixed its tessellation's handedness.
//
// ⚠️ **AND THE PROOF IS NOT THE EDGE TOPOLOGY, BECAUSE THE EDGE TOPOLOGY IS WHAT EVERY PREVIOUS
// PASS AT THIS BUG ALSO BELIEVED.** The verdict is confirmed by RAY PARITY (`scratch/wparity.ts`),
// which never looks at winding at all: a point one hundredth of an inch off a face along that
// face's own normal is outside the shell iff the normal points outward, and "outside" is an
// even/odd crossing count along a fixed direction. Sampled ~250 faces per component:
// `hive_red/frame` 36–56 % of faces pointing INWARD, the flowers 34–50 %, and the perimeter
// `walls` rails **69–76 %**. Two independent methods, the same answer.
//
// WHAT THE TWO EARLIER PASSES GOT WRONG, both of which were reasoning from a partial measurement:
//  - THE GROUND BARS (2026-09-20). "Volume 2.7–7.8× the bounding box, physically impossible" is
//    right, and the A-Frame Top Corner it took as a healthy REFERENCE measures 0.73× — inside its
//    box, so it looked fine — while being 46.6 % reversed. A scrambled shell's divergence sum is a
//    number with no meaning; it lands outside the box sometimes and inside it sometimes, and the
//    reference was the second case.
//  - THE CLEAR PANELS (2026-09-19, `CLEAR_SHEETS_ARE_SINGLE_SIDED`). `sheetFacingBalance` reports
//    "every plane 100 / 0" for the cell skins and the wall glass and reads it as "single-sided
//    sheets". A 0.020-in slab puts BOTH its faces in one plane cluster (the key quantizes the
//    offset at `SHEET_PLANE_TOL_IN` = 0.25 in), so a healthy slab splits that cluster 50 / 50 and
//    100 / 0 means the two faces wind the SAME way — i.e. half of them point into the slab. That
//    is this defect, measured, and named as open sheeting. The panels do measure 0 boundary edges,
//    which a sheet cannot have; the contradiction was in the file the whole time.
//
// THE FIX, PER CONNECTED COMPONENT, CHEAPEST FIRST — `repairGeometryWinding` below:
//  (a) closed and consistently wound already        → nothing (`FrontSide`, one-sided, cheap).
//  (b) closed and consistently wound but INVERTED    → reverse the index winding; still FrontSide.
//  (c) closed with MIXED winding                     → propagate orientation across every shared
//      edge from one seed face, which makes the shell consistent, then reverse the whole shell if
//      its signed volume came out negative. Still FrontSide. This is the case the whole field is.
//  (d) genuinely OPEN sheeting                       → `DoubleSide`, for THAT component only.
//
// ⚠️ **NORMALS ARE NOT A SEPARATE STEP, AND THE ORDER IS WHY.** This pass rewrites the INDEX and
// nothing else, and it runs BEFORE `styleScene`, so `computeCreasedNormals` — which is the one
// normal pass in this file and computes a face normal as `(b−a)×(c−a)` — reads the CORRECTED
// winding and there is no second place for the two to disagree. Reversing a triangle after the
// normals were computed is how a "fixed" face goes black.
//
// ⚠️ **THE CLEAR PANELS ARE SKIPPED ENTIRELY.** `isClearPanel`'s meshes keep their winding, their
// normals and their `DoubleSide` material exactly as they are. Their look is four measured tuning
// passes deep (see the dielectric header) and every one of those numbers was measured against the
// asset as it ships; a winding repair under them would quietly halve the layer count the veil and
// the Fresnel alpha were fitted to. `CLEAR_SHEETS_ARE_SINGLE_SIDED`'s premise is now known to be
// wrong, but its OUTCOME — draw every clear face from both sides — is what the measurements were
// taken under, and it stays until someone re-measures. The RENDER lane pins the skip.
//
// COST. `field.glb`: 268,892 triangles repaired in ~285 ms once at load, against the 149 ms
// `computeCreasedNormals` already spends there; nothing per frame, nothing per instance (the pass
// is keyed by GEOMETRY, so the four flower nodes that share six geometries pay once). DRAW cost is
// UNCHANGED on the high LOD — zero components come out open, so not one triangle moves off
// `FrontSide`, and the field renders one-sided exactly as it did. `field-low.glb` is the only
// place `DoubleSide` is used at all: the simplifier opens real holes in the small parts, and 78 of
// its 174 components (3,498 of 84,708 triangles, **4.1 %**) exceed `OPEN_SHELL_BOUNDARY_FRAC`.
//
// The real defect is still the exporter's — `convert.py` / `assemble-gltf.mjs` should orient the
// tessellation before it merges parts, and `public/models/biobuzz/README.md` carries that note.
// This is the load-time compensation, and it is a no-op the day the asset ships oriented (every
// component classifies (a) and nothing is reversed).

/**
 * How much of a component's own edge budget may be BOUNDARY before it stops counting as a closed
 * shell that merely has holes punched in it and starts counting as genuine sheeting.
 *
 * ⚠️ NOT ZERO, and the low LOD is why. `field.glb` has no boundary edge anywhere, but the
 * simplifier that makes `field-low.glb` nicks small parts: measured there, 23 components carrying
 * **31,352 triangles** have a boundary fraction at or under 3 % — a solid with a few decimated
 * corners, whose signed volume is still its true volume to a fraction of a percent and which is
 * correct and CHEAP one-sided — while 78 components carrying only 3,498 triangles are 3 % or more
 * open, which is what a flattened sheet or a stripped tube looks like. Treating every nick as
 * sheeting would put 41 % of the LOW-detail field on `DoubleSide`, on the preset that can least
 * afford it, to fix nothing.
 */
const OPEN_SHELL_BOUNDARY_FRAC = 0.03;

/**
 * A face-island whose signed volume is under this share of its own bounding box has no usable
 * inside — a flat sliver pair, or the two-triangle offcuts the decimator leaves behind — so its
 * orientation is left exactly as authored rather than decided by the sign of a number that is
 * numerically zero. They cover no pixels either way; what this buys is DETERMINISM, so two loads
 * of the same asset always produce the same index buffer.
 */
const ISLAND_VOLUME_EPS = 1e-6;

/**
 * boundary/flip/volume stats for one connected component's triangles, exported so the RENDER lane
 * can pin the measurement above against the shipped GLB rather than trusting the comment. A
 * "flipped" edge is an undirected edge shared by exactly two triangles that both traverse it in
 * the SAME direction — the signature of a winding inconsistency between two adjacent faces; a
 * properly oriented manifold has every interior edge traversed once each way.
 */
export function shellWindingStats(
  mesh: THREE.Mesh,
  tris: number[],
): { boundaryEdges: number; flippedEdges: number; okInteriorEdges: number; nonManifoldEdges: number; signedVolume: number } {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  mesh.updateWorldMatrix(true, false);
  const at = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
  const key = (p: THREE.Vector3) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  const edgeDirs = new Map<string, ('fwd' | 'bwd')[]>();
  let signedVolume = 0;
  for (const t of tris) {
    const a = v(at(t, 0));
    const b = v(at(t, 1));
    const c = v(at(t, 2));
    const ka = key(a);
    const kb = key(b);
    const kc = key(c);
    for (const [p, q] of [[ka, kb] as const, [kb, kc] as const, [kc, ka] as const]) {
      const canon = p < q;
      const u = canon ? `${p}|${q}` : `${q}|${p}`;
      const dir: 'fwd' | 'bwd' = canon ? 'fwd' : 'bwd';
      const arr = edgeDirs.get(u);
      if (arr) arr.push(dir);
      else edgeDirs.set(u, [dir]);
    }
    signedVolume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
  }
  let boundaryEdges = 0;
  let flippedEdges = 0;
  let okInteriorEdges = 0;
  let nonManifoldEdges = 0;
  for (const dirs of edgeDirs.values()) {
    if (dirs.length === 1) boundaryEdges++;
    else if (dirs.length === 2) {
      if (dirs[0] === dirs[1]) flippedEdges++;
      else okInteriorEdges++;
    } else nonManifoldEdges++;
  }
  return { boundaryEdges, flippedEdges, okInteriorEdges, nonManifoldEdges, signedVolume };
}

/** one connected component's winding verdict, as `analyseMeshShells` reports it. */
export interface ShellComponent {
  tris: number;
  boundaryEdges: number;
  flippedEdges: number;
  okInteriorEdges: number;
  nonManifoldEdges: number;
  /** divergence-theorem volume, meaningful only once the shell is consistently wound */
  signedVolume: number;
  /** `boundaryEdges / totalEdges` — over `OPEN_SHELL_BOUNDARY_FRAC` means sheeting */
  boundaryFraction: number;
  open: boolean;
}

/** what one geometry's repair did. `open` is a per-triangle flag, `null` when nothing is open. */
interface GeometryWinding {
  components: number;
  openComponents: number;
  reversedTris: number;
  openTris: number;
  nonOrientableIslands: number;
  open: Uint8Array | null;
}

/** running totals over a whole load, surfaced on `FieldGroups.winding` and pinned by the lane. */
export interface ShellRepairStats {
  meshes: number;
  components: number;
  openComponents: number;
  totalTris: number;
  /** triangles whose index winding this pass reversed — cases (b) and (c) */
  reversedTris: number;
  /** triangles moved onto a `DoubleSide` sibling mesh — case (d) */
  openTris: number;
  /** triangles left alone because they belong to a clear panel (see the header) */
  clearPanelTris: number;
  /** face-islands that could not be consistently oriented at all — expected 0 */
  nonOrientableIslands: number;
  ms: number;
}

/**
 * The edge topology and winding verdict of every connected component of one mesh, exported so the
 * RENDER lane measures the SHIPPED asset (and the post-repair scene) with this code rather than a
 * re-implementation that could agree with a wrong belief — which is exactly how the two earlier
 * passes at this bug went wrong. See the header above.
 */
export function analyseMeshShells(mesh: THREE.Mesh): ShellComponent[] {
  const { tri, triCount, siteCount, sitePos } = weldTriangles(mesh.geometry);
  if (triCount === 0) return [];
  const topo = shellTopology(tri, triCount, siteCount, sitePos);
  return [...topo.components.values()];
}

/**
 * The shared core: weld -> components -> edges -> face-island orientation. Returns everything both
 * `analyseMeshShells` (read-only) and `repairGeometryWinding` (which rewrites the index) need, so
 * the measurement and the fix can never disagree about what they are looking at.
 */
function shellTopology(
  tri: Int32Array,
  triCount: number,
  siteCount: number,
  sitePos: Float64Array,
): {
  components: Map<number, ShellComponent>;
  componentOf: Int32Array;
  /** +1 keep, −1 reverse, 0 degenerate/untouched */
  orient: Int8Array;
  nonOrientableIslands: number;
} {
  // ⚠️ A DEGENERATE TRIANGLE HAS NO ORIENTATION AND NO ADJACENCY. `KHR_mesh_quantization` snaps
  // positions onto a 16-bit grid and collapses slivers onto it (116 of them in one hive-frame mesh
  // alone), and a collapsed triangle's two coincident corners make a self-edge that would wire
  // unrelated faces together and split the real shell into hundreds of islands. Skipped
  // throughout, left exactly as authored, and they draw no pixels either way.
  const degenerate = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    if (a === b || b === c || c === a) degenerate[t] = 1;
  }

  const componentOf = vertexComponents(tri, triCount, siteCount);

  // ── edges, as flat slots keyed by the undirected welded pair. `dir` is +1 when the triangle
  // traverses the pair in (min, max) order, so two faces sharing an edge are consistently wound
  // exactly when their signed directions cancel.
  const cap = triCount * 3;
  const slotOf = new Map<number, number>();
  const eTri0 = new Int32Array(cap);
  const eTri1 = new Int32Array(cap);
  const eDir0 = new Int8Array(cap);
  const eDir1 = new Int8Array(cap);
  const eUses = new Int32Array(cap);
  let slots = 0;
  for (let t = 0; t < triCount; t++) {
    if (degenerate[t]) continue;
    for (let k = 0; k < 3; k++) {
      const p = tri[t * 3 + k];
      const q = tri[t * 3 + ((k + 1) % 3)];
      const key = p < q ? p * siteCount + q : q * siteCount + p;
      let s = slotOf.get(key);
      if (s === undefined) {
        s = slots++;
        slotOf.set(key, s);
      }
      const used = eUses[s]++;
      if (used === 0) {
        eTri0[s] = t;
        eDir0[s] = p < q ? 1 : -1;
      } else if (used === 1) {
        eTri1[s] = t;
        eDir1[s] = p < q ? 1 : -1;
      }
    }
  }

  const components = new Map<number, ShellComponent>();
  const compOf = (t: number): ShellComponent => {
    const id = componentOf[t];
    let c = components.get(id);
    if (!c) {
      c = {
        tris: 0, boundaryEdges: 0, flippedEdges: 0, okInteriorEdges: 0, nonManifoldEdges: 0,
        signedVolume: 0, boundaryFraction: 0, open: false,
      };
      components.set(id, c);
    }
    return c;
  };
  for (let t = 0; t < triCount; t++) compOf(t).tris++;
  for (let s = 0; s < slots; s++) {
    const c = compOf(eTri0[s]);
    if (eUses[s] === 1) c.boundaryEdges++;
    else if (eUses[s] === 2) {
      if (eDir0[s] === eDir1[s]) c.flippedEdges++;
      else c.okInteriorEdges++;
    } else c.nonManifoldEdges++;
  }

  // ── face-adjacency, over MANIFOLD edges only. A non-manifold edge (two solids fused along a
  // face) is a legitimate junction between two shells that each want their own outward, so
  // propagation deliberately stops at it and each side is oriented by its own volume.
  const adjStart = new Int32Array(triCount + 1);
  for (let s = 0; s < slots; s++) {
    if (eUses[s] !== 2) continue;
    adjStart[eTri0[s] + 1]++;
    adjStart[eTri1[s] + 1]++;
  }
  for (let t = 0; t < triCount; t++) adjStart[t + 1] += adjStart[t];
  const cursor = adjStart.slice(0, triCount);
  const adjTri = new Int32Array(adjStart[triCount]);
  const adjSlot = new Int32Array(adjStart[triCount]);
  for (let s = 0; s < slots; s++) {
    if (eUses[s] !== 2) continue;
    const u = eTri0[s];
    const v = eTri1[s];
    adjTri[cursor[u]] = v;
    adjSlot[cursor[u]++] = s;
    adjTri[cursor[v]] = u;
    adjSlot[cursor[v]++] = s;
  }

  const orient = new Int8Array(triCount);
  let nonOrientableIslands = 0;
  const stack: number[] = [];
  const island: number[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (orient[seed] !== 0 || degenerate[seed]) continue;
    orient[seed] = 1;
    stack.length = 0;
    island.length = 0;
    stack.push(seed);
    let conflict = false;
    while (stack.length > 0) {
      const u = stack.pop()!;
      island.push(u);
      for (let i = adjStart[u]; i < adjStart[u + 1]; i++) {
        const v = adjTri[i];
        const s = adjSlot[i];
        // u and v both traverse the shared edge; consistently wound means the signs cancel
        const du = (eTri0[s] === u ? eDir0[s] : eDir1[s]) * orient[u];
        const dv = eTri0[s] === u ? eDir1[s] : eDir0[s];
        const want: 1 | -1 = du * dv > 0 ? -1 : 1;
        if (orient[v] === 0) {
          orient[v] = want;
          stack.push(v);
        } else if (orient[v] !== want) conflict = true;
      }
    }
    if (conflict) nonOrientableIslands++;

    // ...and now turn the island outward. `Σ a·(b×c)/6` over consistently wound triangles is the
    // enclosed volume, POSITIVE when the faces point out — in the geometry's own local frame,
    // which is safe because every node on this asset has a positive-determinant world matrix
    // (`assembleFieldGroups` asserts it) and a rotation cannot change a winding's handedness.
    let vol = 0;
    let bx0 = Infinity; let by0 = Infinity; let bz0 = Infinity;
    let bx1 = -Infinity; let by1 = -Infinity; let bz1 = -Infinity;
    for (const t of island) {
      const s = orient[t];
      const ia = tri[t * 3];
      const ib = tri[t * 3 + (s > 0 ? 1 : 2)];
      const ic = tri[t * 3 + (s > 0 ? 2 : 1)];
      const ax = sitePos[ia * 3]; const ay = sitePos[ia * 3 + 1]; const az = sitePos[ia * 3 + 2];
      const bx = sitePos[ib * 3]; const by = sitePos[ib * 3 + 1]; const bz = sitePos[ib * 3 + 2];
      const cx = sitePos[ic * 3]; const cy = sitePos[ic * 3 + 1]; const cz = sitePos[ic * 3 + 2];
      vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] as const) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      }
    }
    const bbox = Math.max((bx1 - bx0) * (by1 - by0) * (bz1 - bz0), 1e-12);
    if (vol < 0 && Math.abs(vol) / bbox > ISLAND_VOLUME_EPS) {
      for (const t of island) orient[t] = orient[t] > 0 ? -1 : 1;
      vol = -vol;
    }
    compOf(seed).signedVolume += vol;
  }

  for (const c of components.values()) {
    const edges = c.boundaryEdges + c.flippedEdges + c.okInteriorEdges + c.nonManifoldEdges;
    c.boundaryFraction = edges > 0 ? c.boundaryEdges / edges : 1;
    c.open = c.boundaryFraction > OPEN_SHELL_BOUNDARY_FRAC;
  }
  return { components, componentOf, orient, nonOrientableIslands };
}

/**
 * Repairs ONE geometry's winding in place — cases (a)–(c) of the header — and reports which of its
 * triangles belong to a genuinely open component, case (d), for the caller to route onto a
 * `DoubleSide` sibling. Only the INDEX is rewritten; positions and every other attribute are
 * untouched, which is why this is cheap enough to run at load over the whole field.
 */
function repairGeometryWinding(geo: THREE.BufferGeometry): GeometryWinding {
  const none: GeometryWinding = {
    components: 0, openComponents: 0, reversedTris: 0, openTris: 0, nonOrientableIslands: 0, open: null,
  };
  const { tri, triCount, siteCount, sitePos } = weldTriangles(geo);
  if (triCount === 0) return none;
  const { components, componentOf, orient, nonOrientableIslands } = shellTopology(tri, triCount, siteCount, sitePos);

  const idx = geo.getIndex()!;
  let reversedTris = 0;
  for (let t = 0; t < triCount; t++) {
    if (orient[t] >= 0) continue;
    const b = idx.getX(t * 3 + 1);
    idx.setX(t * 3 + 1, idx.getX(t * 3 + 2));
    idx.setX(t * 3 + 2, b);
    reversedTris++;
  }
  if (reversedTris > 0) idx.needsUpdate = true;

  let openComponents = 0;
  let openTris = 0;
  let open: Uint8Array | null = null;
  for (const c of components.values()) if (c.open) openComponents++;
  if (openComponents > 0) {
    open = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) {
      if (!components.get(componentOf[t])?.open) continue;
      open[t] = 1;
      openTris++;
    }
  }
  return { components: components.size, openComponents, reversedTris, openTris, nonOrientableIslands, open };
}

/**
 * Walks every mesh of the loaded scene and repairs its winding — see the header above.
 *
 * Keyed by GEOMETRY, not by mesh: the four `flower_*` nodes share six geometries between them, and
 * reversing a shared index buffer once per instance would reverse it four times, which is a no-op
 * and an extremely quiet one. Clear-panel meshes are skipped entirely.
 *
 * Runs BEFORE `styleScene`, so it reads the glTF's own `<finish>#<hex>` material names (which is
 * what `isClearPanel` is keyed on) and so `computeCreasedNormals` sees the corrected winding.
 */
function repairFieldWinding(root: THREE.Object3D): { stats: ShellRepairStats; open: Map<THREE.BufferGeometry, Uint8Array> } {
  const t0 = nowMs();
  const stats: ShellRepairStats = {
    meshes: 0, components: 0, openComponents: 0, totalTris: 0, reversedTris: 0, openTris: 0,
    clearPanelTris: 0, nonOrientableIslands: 0, ms: 0,
  };
  const open = new Map<THREE.BufferGeometry, Uint8Array>();
  const done = new Set<THREE.BufferGeometry>();
  const walk = (obj: THREE.Object3D, family: NodeFamily): void => {
    const own = nodeFamilyOf((obj.userData as { name?: string } | undefined)?.name ?? obj.name);
    const here = own ?? family;
    if (obj instanceof THREE.Mesh && obj.geometry) {
      const src = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const parsed = parseMaterialName(src?.name);
      const tris = triangleCount(obj.geometry);
      if (parsed && isClearPanel(parsed.finish, parsed.colorHex, here)) {
        stats.clearPanelTris += tris;
      } else if (!done.has(obj.geometry)) {
        done.add(obj.geometry);
        stats.meshes++;
        stats.totalTris += tris;
        const r = repairGeometryWinding(obj.geometry);
        stats.components += r.components;
        stats.openComponents += r.openComponents;
        stats.reversedTris += r.reversedTris;
        stats.openTris += r.openTris;
        stats.nonOrientableIslands += r.nonOrientableIslands;
        if (r.open) open.set(obj.geometry, r.open);
      }
    }
    for (const child of obj.children) walk(child, here);
  };
  walk(root, 'other');
  stats.ms = nowMs() - t0;
  return { stats, open };
}

function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  const pos = geo.getAttribute('position');
  return Math.floor((idx ? idx.count : (pos?.count ?? 0)) / 3);
}

/** a load-time stopwatch that degrades to 0 where there is no `performance` (the Node lane). */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
}

/** one `THREE.DoubleSide` clone per source material, so every open component sharing a finish
 *  reuses one instance — and so the ORIGINAL cached material (shared with the correctly-wound
 *  parts in `styleScene`'s own cache) is never mutated in place. */
const doubleSidedMaterialCache = new Map<THREE.Material, THREE.Material>();
function doubleSidedMaterial(src: THREE.Material): THREE.Material {
  let mat = doubleSidedMaterialCache.get(src);
  if (!mat) {
    mat = src.clone();
    mat.side = THREE.DoubleSide;
    mat.name = `${src.name}|doubleside`;
    doubleSidedMaterialCache.set(src, mat);
  }
  return mat;
}

/**
 * Case (d): moves each genuinely OPEN component's triangles onto their own sibling mesh, rendered
 * `DoubleSide`. Everything else in the mesh is untouched and stays `FrontSide` — the "scoped, not
 * blanket" property `fixGroundBeamWinding` had and the RENDER lane still asserts.
 *
 * ⚠️ IN THE GEOMETRY'S OWN LOCAL FRAME, AND ONCE PER GEOMETRY. The predecessor baked WORLD
 * coordinates and then un-did the node transform, which is correct for a mesh with one user and
 * silently wrong for the six geometries the four flower nodes SHARE: the first flower's world bake
 * would be handed to all four. The split part is added as a CHILD of its source mesh, so it
 * inherits that mesh's own transform whatever it is and the shared result is placed correctly four
 * times over.
 *
 * Runs AFTER `styleScene`, because it clones the resolved runtime material.
 */
function splitOpenShells(root: THREE.Object3D, open: Map<THREE.BufferGeometry, Uint8Array>): number {
  if (open.size === 0) return 0;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && open.has(o.geometry)) meshes.push(o);
  });
  const split = new Map<THREE.BufferGeometry, { kept: THREE.BufferGeometry; open: THREE.BufferGeometry }>();
  let movedTris = 0;
  for (const mesh of meshes) {
    const flags = open.get(mesh.geometry);
    if (!flags) continue;
    let parts = split.get(mesh.geometry);
    if (!parts) {
      const made = splitGeometryLocal(mesh.geometry, flags);
      if (!made) continue;
      parts = made;
      split.set(mesh.geometry, parts);
      movedTris += triangleCount(parts.open);
    }
    mesh.geometry = parts.kept;
    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const part = new THREE.Mesh(parts.open, doubleSidedMaterial(src));
    part.name = `${mesh.name || 'mesh'}/doubleside`;
    part.castShadow = mesh.castShadow;
    part.receiveShadow = mesh.receiveShadow;
    part.renderOrder = mesh.renderOrder;
    // ⚠️ the marker `meshesUnder` filters on. Without it the printed-markings pass would find a
    // `decal#ffffff` split twice and build every AprilTag plate and banner two deep.
    part.userData.bbDoubleSided = true;
    mesh.add(part);
  }
  return movedTris;
}

/** splits one geometry's triangles into (kept, open) by a per-triangle flag, LOCAL frame, index
 *  only — both halves share nothing with the original, which is disposed. */
function splitGeometryLocal(
  geo: THREE.BufferGeometry,
  flags: Uint8Array,
): { kept: THREE.BufferGeometry; open: THREE.BufferGeometry } | null {
  const idx = geo.getIndex();
  if (!idx) return null;
  const triCount = Math.floor(idx.count / 3);
  const keptIdx: number[] = [];
  const openIdx: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const dst = flags[t] ? openIdx : keptIdx;
    dst.push(idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2));
  }
  if (openIdx.length === 0) return null;
  // ⚠️ EVERY ATTRIBUTE IS COPIED THROUGH `getX/getY/getZ/getW`, for the `KHR_mesh_quantization`
  // reason `partitionTrianglesWorld` documents: a position attribute is a NORMALIZED Int16Array
  // and its raw array holds counts, not inches.
  const names = Object.keys(geo.attributes);
  const get = (src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, k: number): number =>
    k === 0 ? src.getX(i) : k === 1 ? src.getY(i) : k === 2 ? src.getZ(i) : src.getW(i);
  // the halves stay INDEXED, over only the vertices each one actually names — de-indexing here
  // would triple the vertex pool of the KEPT half, which is 96 % of the mesh.
  const build = (order: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const remap = new Map<number, number>();
    const used: number[] = [];
    const out = new Uint32Array(order.length);
    for (let i = 0; i < order.length; i++) {
      let n = remap.get(order[i]);
      if (n === undefined) {
        n = used.length;
        remap.set(order[i], n);
        used.push(order[i]);
      }
      out[i] = n;
    }
    for (const name of names) {
      const src = geo.getAttribute(name);
      const size = src.itemSize;
      const dst = new Float32Array(used.length * size);
      for (let i = 0; i < used.length; i++) for (let k = 0; k < size; k++) dst[i * size + k] = get(src, used[i], k);
      g.setAttribute(name, new THREE.BufferAttribute(dst, size));
    }
    g.setIndex(new THREE.BufferAttribute(out, 1));
    if (!g.getAttribute('normal')) computeCreasedNormals(g, CREASE_ANGLE_DEG);
    return g;
  };
  const kept = build(keptIdx);
  const open = build(openIdx);
  geo.dispose();
  return { kept, open };
}

/**
 * Moves the eight tray braces AND the two pivot rockers out of the three hive FRAME nodes and
 * into the alliance's own tray pivot group, so they swing with the cell they belong to. Returns
 * how many triangles moved of each, which the RENDER lane asserts is not zero on the shipped
 * asset.
 */
function reparentTrayBraces(
  root: THREE.Object3D,
  hives: { red: FieldHiveGroup; blue: FieldHiveGroup },
): { braceTris: number; rockerTris: number } {
  const pivots = trayPivotX();
  let braceTris = 0;
  let rockerTris = 0;
  for (const nodeName of HIVE_FRAME_NODES) {
    const node = findOptional(root, nodeName);
    if (!node) continue;
    const meshes: THREE.Mesh[] = [];
    node.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    for (const mesh of meshes) {
      // the ROCKER is decided per whole component, the BRACES per triangle centroid — see the two
      // blocks above for why each selector is the shape it is.
      const { ofTriangle, spans } = weldedComponents(mesh);
      const rockerOf = new Map<number, Alliance>();
      for (const [id, s] of spans) {
        for (const a of ['red', 'blue'] as const) {
          if (Math.max(Math.abs(s.xMin - pivots[a]), Math.abs(s.xMax - pivots[a])) <= ROCKER_HALF_SPAN_IN) rockerOf.set(id, a);
        }
      }
      // ONE pass, labelled by alliance — `hive_shared/frame` holds two of red's braces and two of
      // blue's, so the split has to name both in the same sweep. A brace belongs to whichever
      // pivot it is nearer: they sit at the cell's own |x_local| ≈ 9.5, half the hive spacing.
      const parts = partitionTrianglesWorld(mesh, (cx, cy, cz, tri) => {
        const rocker = rockerOf.get(ofTriangle[tri]);
        if (rocker) return `rocker:${rocker}`;
        if (!isTrayBracePoint(cy, cz)) return null;
        return `brace:${Math.abs(cx - pivots.red) < Math.abs(cx - pivots.blue) ? 'red' : 'blue'}`;
      });
      for (const [label, geo] of parts) {
        const [kind, side] = label.split(':');
        const alliance = side as Alliance;
        // ⚠️ UN-TILT BEFORE PARENTING, or the brace is rotated TWICE. The tray MESH is exported in
        // the pivot-local UN-TILTED frame (`convert.py` rotates every tray point out of the STEP's
        // capture pose, which is why `refTheta` is 0 and `updateBiobuzzField` applies the absolute
        // `hiveTiltAngle`) — but a FRAME node is world-absolute, so these braces come off the disc
        // already sitting at ±30°. Parenting them as-is and then applying the tilt puts them at
        // `captureTheta + hiveTiltAngle`: they swing, at double the angle, which looks worse than
        // the bug being fixed. `world = pivot + Rot_x(captureTheta)·(x, v, w)`, so the inverse is
        // exactly this.
        const tray = fieldColliders3d().trays[alliance];
        const toLocal = new THREE.Matrix4()
          .makeRotationX(-cadCaptureTheta(alliance))
          .multiply(new THREE.Matrix4().makeTranslation(-tray.pivot[0], -tray.pivot[1], -tray.pivot[2]));
        geo.applyMatrix4(toLocal);
        const part = new THREE.Mesh(geo, mesh.material);
        part.name = `hive_${alliance}/tray-${kind}`;
        part.castShadow = true;
        part.receiveShadow = true;
        // the source may itself be a `splitOpenShells` sibling (the low LOD's decimated frame
        // parts), in which case these triangles are open-shell triangles too and the material they
        // inherit is the DoubleSide clone. Carry the marker so they are not read as a blanket
        // doubling of a correctly-wound part.
        if (mesh.userData.bbDoubleSided) part.userData.bbDoubleSided = true;
        const tris = geo.getAttribute('position').count / 3;
        if (kind === 'rocker') rockerTris += tris;
        else braceTris += tris;
        hives[alliance].tray.add(part);
      }
    }
  }
  return { braceTris, rockerTris };
}

// ── PRINTED FIELD MARKINGS — the HIGH LOD only ────────────────────────────────────────────────
//
// 2026-09-19 playtest, owner items 11 and 13: "the flower's purple top guard part does not have
// standoffs rendered in game. For higher graphics settings, it should be rendered", and "April
// tags and FTC Biobuzz banner in the center structure should be rendered for higher graphics
// settings."
//
// All three are CAD parts the pipeline either drops or ships BLANK:
//
//  - THE TAG CLUSTERS. `am-5888-{red,blue}{1,2}: Goal April Tag` ×4 ARE in both GLBs, as
//    `decal#ffffff` plates measuring 17.0005 × 5.0009 × 0.0105 in on the UNDERSIDE of each cell
//    floor (tray-local w −1.4976…−1.4872, against the floor skin's own outer face at −1.4884) —
//    four blank white rectangles, because a STEP file carries no artwork. §9.9 (p74) says what
//    goes on them and `docs/biobuzz/manual-distilled.md` §5.5 has it distilled; `TAG_IDS` below
//    carries the IDs and the placement rule.
//  - THE BANNER. `am-5883: Panel Sticker` ×2, likewise `decal#ffffff`, on the two outward faces
//    of the `am-5877 ACM Panel` logo board that spans both hives — a 29.0 × 5.44 in face leaning
//    24° back, at z 34.5…39.6. Also blank.
//  - THE FLOWER STANDOFFS. `am-1696: Nylon Spacer, 0.194in ID, 0.375in OD, 1.000in Long` ×2 per
//    flower, the spacers the purple `am-5884: Flower Backstop` stands on. These are not blank —
//    they are ABSENT, swallowed by `convert.py`'s `RE_FASTENER`, which matches the bare words
//    `nylon spacer`. Exactly the class of bug §2.2 of the audit records for the 24 perimeter
//    rails ("FTC Rail with **Rivet** Holes"). Measured in the STEP (flower F4, mm, min corner):
//    (652.3, 543.7, 1739.3) and (526.5, 543.7, 1739.3), i.e. sim z 21.406 → 22.406 — the gap
//    between the amber top ring's top face (21.404) and the backstop's underside (22.404), which
//    is the spacer's own stated 1.000 in. THE ONE-LINE REAL FIX IS IN `PART_RULES`; it is not
//    made here, for the reason `reparentTrayBraces` states above (re-running `npm run field-cad`
//    rewrites `fieldColliders.gen.ts`, which is a sim change and not this lane's).
//
// HIGH LOD ONLY, which is `GraphicsSettings.meshDetail` and therefore MEDIUM and up: nothing
// below is built, no canvas is allocated and no texture is uploaded when `quality` is `'low'`.
// Every texture hangs off a material under the field group, so `renderCore.ts`'s
// `disposeObject3D` frees it with the scene (it disposes `material.map`).

/**
 * THE 36h11 CODE TABLE, for the sixteen IDs BIOBUZZ uses and no others.
 *
 * Source: `tag36h11.c` from AprilRobotics/apriltag (BSD-2-Clause), `codedata[]` entries 30–45 and
 * the `bit_x`/`bit_y` layout verbatim. A tag is `total_width` 10 cells — a 1-cell white quiet
 * zone around an 8-cell (`width_at_border`) black square, whose inner 6×6 carries the 36 code
 * bits MSB first at `(bit_x[i], bit_y[i])`, `reversed_border` false. Generating the bitmap beats
 * shipping sixteen PNGs: 16 numbers and 72 offsets against ~16 KB of image.
 */
const TAG_BIT_X = [1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4, 1, 1, 1, 1, 1, 2, 2, 2, 3] as const;
const TAG_BIT_Y = [1, 1, 1, 1, 1, 2, 2, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4, 3, 6, 6, 6, 6, 6, 5, 5, 5, 4, 6, 5, 4, 3, 2, 5, 4, 3, 4] as const;
/** `codedata[30]` … `codedata[45]`. 36-bit integers — exact as doubles, so no BigInt. */
const TAG_CODES: Readonly<Record<number, number>> = {
  30: 0x0e2cfda160,
  31: 0x02ff497c63,
  32: 0x047240671b,
  33: 0x05047a2e55,
  34: 0x0635ca87c7,
  35: 0x0691254166,
  36: 0x068f43d94a,
  37: 0x06ef24bdb6,
  38: 0x08cdd8f886,
  39: 0x09de96b718,
  40: 0x0aff6e5a8a,
  41: 0x0bae46f029,
  42: 0x0d225b6d59,
  43: 0x0df8ba8c01,
  44: 0x0e3744a22f,
  45: 0x0fbb59375d,
};

/** one tag as a 10×10 grid, row-major from the TOP, `1` = white. Exported for the RENDER lane,
 * which has no DOM and so cannot look at the texture. */
export function apriltag36h11Cells(id: number): Uint8Array {
  const code = TAG_CODES[id];
  if (code === undefined) throw new Error(`apriltag36h11Cells: no code for tag ${id} (BIOBUZZ uses 30..45)`);
  const cells = new Uint8Array(100).fill(1);
  const off = 1; // (total_width 10 − width_at_border 8) / 2
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) cells[(r + off) * 10 + (c + off)] = 0;
  for (let i = 0; i < 36; i++) {
    const bit = Math.floor(code / 2 ** (35 - i)) % 2;
    cells[(TAG_BIT_Y[i] + off) * 10 + (TAG_BIT_X[i] + off)] = bit;
  }
  return cells;
}

/**
 * WHICH CLUSTER GOES ON WHICH CELL — §9.9 p76, read off the page raster (that page's text layer
 * drops most of the digits; `docs/biobuzz/manual-distilled.md`'s header lists it as a known
 * defect). The AUDIENCE is at −y, which is the side F4 sits on.
 */
export const TAG_IDS: Readonly<Record<Alliance, Readonly<Record<'north' | 'south', readonly number[]>>>> = {
  // "red CELL on the side of the FIELD opposite the audience" / "red CELL on the audience side"
  red: { north: [30, 31, 32, 33], south: [34, 35, 36, 37] },
  // "blue CELL on the audience side" / "blue CELL on the side opposite the audience"
  blue: { north: [42, 43, 44, 45], south: [38, 39, 40, 41] },
};
/** what Fig 9-16's sticker prints on itself, per cell. */
const TAG_LABEL: Readonly<Record<Alliance, Readonly<Record<'north' | 'south', string>>>> = {
  red: { north: 'RED FAR', south: 'RED AUDIENCE' },
  blue: { north: 'BLUE FAR', south: 'BLUE AUDIENCE' },
};

/** §9.9 p74: "AprilTags for BIOBUZZ are 3.25 in. (8.25 cm) square targets from the 36h11 tag
 * family." That is the black-bordered square; the quiet zone is the white plate around it. */
export const TAG_SIZE_IN = 3.25;
/** §9.9 p74, and what Fig 9-16 letters on the sticker under the cell name. */
const TAG_FAMILY = '36h11';
/** one CELL of a 36h11 tag — the tag is 10 of them across, and a DECODER reads one bit per cell.
 *  Exported because the bleed's undecodability is stated against this length. */
export const TAG_CELL_IN = TAG_SIZE_IN / 10;
/**
 * ⚠️ APPROX — THE MANUAL'S OWN PITCH CANNOT BE RIGHT AS DISTILLED. `docs/biobuzz-reference.md`
 * §2.2 reads Fig 9-15 as "tags on 2.75-in centres in two pairs 7.0 in apart", and
 * `manual-distilled.md` §9 already flags that line as measured off a drawing rather than stated:
 * 2.75-in centres would overlap two 3.25-in tags by half an inch. 3.5 is the smallest pitch that
 * clears, and it makes the two PAIR centres exactly the 7.0 in the same figure calls out. The
 * row lands 13.75 in wide on the CAD's 17.0005-in plate, 1.63 in clear at each end.
 */
const TAG_PITCH_IN = 3.5;
/** px per tag CELL — the tag is drawn on integer cell boundaries so `NearestFilter` keeps the
 * bits square. 12 puts a 3.25-in tag at 120 px. */
const TAG_CELL_PX = 12;

function tagClusterTexture(ids: readonly number[], label: string, plateW: number, plateH: number): THREE.CanvasTexture {
  const pxPerIn = (TAG_CELL_PX * 10) / TAG_SIZE_IN;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(plateW * pxPerIn);
  canvas.height = Math.round(plateH * pxPerIn);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('tagClusterTexture: no 2d context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // ⚠️ THE ROW SITS LOW ON THE CANVAS, AND THAT IS THE ORIENTATION RULE, NOT A MARGIN CHOICE.
  // §9.9 p75: the cluster faces down "with its bottom edge oriented towards the center of the
  // FIELD". The quad this paints has its +y (canvas TOP, v = 1) pointing AWAY from the field
  // centre, so canvas-down IS field-centre-ward and an upright tag's bottom edge already points
  // the right way. The label takes the wider margin that leaves.
  const tagPx = TAG_CELL_PX * 10;
  const top = Math.round(canvas.height - 0.4 * pxPerIn - tagPx);
  for (let k = 0; k < ids.length; k++) {
    const cells = apriltag36h11Cells(ids[k]);
    const left = Math.round((plateW / 2 + (k - (ids.length - 1) / 2) * TAG_PITCH_IN) * pxPerIn - tagPx / 2);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (cells[r * 10 + c] === 0) ctx.fillRect(left + c * TAG_CELL_PX, top + r * TAG_CELL_PX, TAG_CELL_PX, TAG_CELL_PX);
      }
    }
  }
  // THE LABEL IS WHAT FIG 9-16 PRINTS, AND NOTHING ELSE. `manual-distilled.md` §9.9: "The
  // cluster sticker in Fig 9-16 is labelled per cell, e.g. 'RED AUDIENCE / Tag family: 36h11'."
  // Two lines, the cell name over the family — this used to run them together with the four IDs
  // appended (`RED AUDIENCE · 36h11 · 34 35 36 37`), which is a caption the real sticker does
  // not carry. The IDs are on the tags.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nameSize = Math.round(0.6 * pxPerIn);
  const familySize = Math.round(0.4 * pxPerIn);
  ctx.fillStyle = '#1b1f24';
  ctx.font = `700 ${nameSize}px system-ui, sans-serif`;
  ctx.fillText(label, canvas.width / 2, top / 2 - familySize * 0.7);
  ctx.fillStyle = '#3c4450';
  ctx.font = `500 ${familySize}px system-ui, sans-serif`;
  ctx.fillText(`Tag family: ${TAG_FAMILY}`, canvas.width / 2, top / 2 + nameSize * 0.7);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * ── THE BLEED-THROUGH, ON THE UPPER FACE OF THE SAME CELL FLOOR ────────────────────────────
 *
 * §9.9 puts the cluster sticker on the BOTTOM face of each CELL, facing DOWN at the tiles, and
 * that stays exactly as it is. But the sticker is WHITE VINYL on a TRANSLUCENT polycarbonate
 * floor, so from above it is not invisible: you see white bleeding through, with a suggestion of
 * something darker inside it. Owner, 2026-09-19 — "the AprilTag sticker shows from below but not
 * from above, and it should faintly."
 *
 * ⚠️ **IT MUST NOT BE DECODABLE FROM THE WRONG SIDE, AND THAT IS ENFORCED AT RASTER TIME, NOT BY
 * TURNING THE OPACITY DOWN.** A faint but crisp copy still carries all 36 bits: a detector
 * thresholds, it does not care how grey the ink is. So the bleed canvas is rasterized at
 * `TAG_BLEED_PX_PER_IN`, a pitch of 0.714 in against a tag CELL of 0.325 — **2.2 cells per
 * pixel**. The bits are averaged away by the rasterizer before the texture exists; there is no
 * resolution at which they come back, and `LinearFilter` on the way up smears what is left.
 * The RENDER lane checks that ratio rather than the opacity, because the ratio is the guarantee.
 */
const TAG_BLEED_PX_PER_IN = 1.4;
/** how much of the bleed quad shows. Against the crisp sticker's opaque decal this is a whisper;
 *  it is the SECOND line of defence, and the raster pitch above is the first. */
const TAG_BLEED_OPACITY = 0.3;
/** the white the vinyl carries through the panel, and the grey the tag ink shows as. Neither is
 *  the sticker's own `#ffffff`/`#000000`: two layers of translucent polycarbonate between the
 *  eye and the ink is what a low-contrast pair means here. */
const TAG_BLEED_WHITE = '#f2f4f6';
const TAG_BLEED_INK = '#a8b2bc';

function tagBleedTexture(ids: readonly number[], plateW: number, plateH: number): THREE.CanvasTexture {
  const pxPerIn = TAG_BLEED_PX_PER_IN;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(plateW * pxPerIn));
  canvas.height = Math.max(2, Math.round(plateH * pxPerIn));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('tagBleedTexture: no 2d context');
  // the WHITE sticker itself, coming through the panel — this is most of the effect
  ctx.fillStyle = TAG_BLEED_WHITE;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // and the dark cells, laid down at the same sub-cell pitch the row is. Each `fillRect` here is
  // a fraction of a pixel wide, so the rasterizer's own coverage blending is what destroys the
  // code; nothing is drawn at bit resolution and then blurred.
  const tagIn = TAG_SIZE_IN;
  const cellIn = TAG_CELL_IN;
  const topIn = plateH - 0.4 - tagIn;
  ctx.fillStyle = TAG_BLEED_INK;
  for (let k = 0; k < ids.length; k++) {
    const cells = apriltag36h11Cells(ids[k]);
    const leftIn = plateW / 2 + (k - (ids.length - 1) / 2) * TAG_PITCH_IN - tagIn / 2;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (cells[r * 10 + c] !== 0) continue;
        ctx.fillRect((leftIn + c * cellIn) * pxPerIn, (topIn + r * cellIn) * pxPerIn, cellIn * pxPerIn, cellIn * pxPerIn);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // LINEAR both ways: the point is the smear. `NearestFilter` (what the crisp sticker uses to
  // keep its bits square) would hand back hard 0.7-in blocks, which reads as a checkerboard
  // rather than as something seen through a panel.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** the bleed's own material: translucent, unlit-ish and never a shadow caster. Not
 *  `decalMaterial` — that one is opaque, which is right for a sticker and wrong for a stain. */
function bleedMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    metalness: 0,
    roughness: 0.95,
    transparent: true,
    opacity: TAG_BLEED_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: DECAL_POLYGON_OFFSET,
    polygonOffsetUnits: DECAL_POLYGON_OFFSET,
  });
}

/**
 * The centre structure's ACM panel face.
 *
 * ⚠️ **IT IS BLANK, AND THAT IS THE CAD, NOT A PLACEHOLDER.** The comment block above (the blank
 * `decal#ffffff` inventory) records what the STEP ships here: `am-5883: Panel Sticker` ×2 on the
 * two outward faces of the `am-5877 ACM Panel` board, both BLANK. This function used to letter
 * "F I R S T   T E C H   C H A L L E N G E" / "BIOBUZZ" and an amber rule across it — invented
 * artwork painted onto blank source data, and the owner called it out as wrong (2026-09-19).
 * §9 also notes the logo panel may not be present at every event, so a blank panel is a real
 * field configuration rather than a compromise.
 *
 * ⚠️ **AND A HAND-REDRAWN WORDMARK IS NOT THE ALTERNATIVE.** FIRST's *Policy on the Use of FIRST
 * Trademarks and Copyrighted Materials* (rev 04/19/25) restricts the LOGO marks hardest — they
 * are "not available for use by anyone other than by currently registered FIRST Teams to identify
 * their own Teams and activities, by FIRST Committees and Partners, or by separate written
 * agreement with FIRST" — while field DESIGNS sit in the more permissive copyright tier this
 * whole CAD pipeline relies on. The brand guidelines additionally say to use only the versions
 * provided and forbid altered ones, so a redraw is both a reproduction and a guideline breach.
 * Do not put a logo back, in any form, including a "close enough" traced one.
 *
 * What it draws instead is a PANEL: the ACM board's own white face with the shading that makes it
 * read as a physical sheet — a vertical gradient off the light rig, a faint edge darkening, and
 * the brushed-composite tone — rather than a flat white rectangle.
 */
/** the bottom of the ACM face's own gradient, and the tone its wrapped edge shows. */
const PANEL_STICKER_SHADE = '#e4e7ea';
const PANEL_STICKER_EDGE = 'rgba(80, 90, 102, 0.28)';

function bannerTexture(wIn: number, hIn: number): THREE.CanvasTexture {
  const pxPerIn = 16;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(wIn * pxPerIn);
  canvas.height = Math.round(hIn * pxPerIn);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('bannerTexture: no 2d context');
  // the sheet, top-lit: the board leans 24 degrees back, so its own face catches more of the
  // rig at the top edge than at the bottom one
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, PANEL_STICKER_SHADE);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // the sticker's edge — a real applied vinyl face is a hair darker where it wraps the board,
  // which is what stops a white rectangle reading as a hole in the structure. Drawn INSIDE the
  // face as a soft band rather than as a stroked outline: this file runs no outline pass at all
  // (see `clearPanelMaterial`'s header), and a 1-px stroke on a leaning quad aliases into dashes.
  const inset = Math.max(1, Math.round(0.18 * pxPerIn));
  const edge = ctx.createLinearGradient(0, 0, canvas.width, 0);
  edge.addColorStop(0, PANEL_STICKER_EDGE);
  edge.addColorStop(inset / canvas.width, 'rgba(0,0,0,0)');
  edge.addColorStop(1 - inset / canvas.width, 'rgba(0,0,0,0)');
  edge.addColorStop(1, PANEL_STICKER_EDGE);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** the ACM board's face: aluminium composite under a vinyl sticker is semi-gloss, not the matt
 *  0.85 a printed floor decal is, and that sheen is the other half of "a panel, not a white
 *  rectangle". Same polygon offset as every other thing printed on a surface. */
function panelStickerMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    metalness: 0.08,
    roughness: 0.42,
    polygonOffset: true,
    polygonOffsetFactor: DECAL_POLYGON_OFFSET,
    polygonOffsetUnits: DECAL_POLYGON_OFFSET,
  });
}

function decalMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    metalness: 0,
    roughness: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: DECAL_POLYGON_OFFSET,
    polygonOffsetUnits: DECAL_POLYGON_OFFSET,
  });
}

interface FacetFrame {
  centre: THREE.Vector3;
  quaternion: THREE.Quaternion;
  width: number;
  height: number;
}

/**
 * The OUTERMOST planar face of `mesh` among the triangles `keep` accepts, as a world-space frame:
 * +z is that face's outward normal, +y is `up` projected into it, +x = y × z (right-handed, so a
 * texture mapped onto a quad in this frame reads unmirrored from outside). `width`/`height` are
 * the face's own extents along +x/+y.
 *
 * Measuring instead of hard-coding is the point: the plate rectangles and the banner's 24° lean
 * are CAD, and the CAD is authoritative for dimensions (owner ruling 2026-09-18). A field
 * revision that moves a sticker moves the artwork with it.
 */
function facetFrame(
  mesh: THREE.Mesh,
  keep: (cx: number, cy: number, cz: number) => boolean,
  outward: THREE.Vector3,
  up: THREE.Vector3,
): FacetFrame | null {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  mesh.updateWorldMatrix(true, false);
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const n = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const face = new THREE.Vector3();
  const used = new Set<number>();
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const pa = pts[a];
    const pb = pts[b];
    const pc = pts[c];
    if (!keep((pa.x + pb.x + pc.x) / 3, (pa.y + pb.y + pc.y) / 3, (pa.z + pb.z + pc.z) / 3)) continue;
    e1.subVectors(pc, pb);
    e2.subVectors(pa, pb);
    face.copy(e1).cross(e2);
    const twiceArea = face.length();
    if (twiceArea <= 0) continue;
    face.divideScalar(twiceArea);
    if (face.dot(outward) < 0.7) continue;
    n.addScaledVector(face, twiceArea / 2);
    used.add(a);
    used.add(b);
    used.add(c);
  }
  if (used.size === 0 || n.lengthSq() === 0) return null;
  n.normalize();
  const y = up.clone().addScaledVector(n, -up.dot(n));
  if (y.lengthSq() === 0) return null;
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, n);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  let d = -Infinity;
  for (const i of used) {
    const p = pts[i];
    uMin = Math.min(uMin, p.dot(x));
    uMax = Math.max(uMax, p.dot(x));
    vMin = Math.min(vMin, p.dot(y));
    vMax = Math.max(vMax, p.dot(y));
    d = Math.max(d, p.dot(n));
  }
  const centre = new THREE.Vector3()
    .addScaledVector(x, (uMin + uMax) / 2)
    .addScaledVector(y, (vMin + vMax) / 2)
    .addScaledVector(n, d);
  return {
    centre,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n)),
    width: uMax - uMin,
    height: vMax - vMin,
  };
}

/** the glTF material name `styleScene` was handed, recovered from the `<material>@<family>` key
 * it renamed the runtime material to. */
function glbMaterialName(obj: THREE.Mesh): string {
  const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
  const name = m && !Array.isArray(m) ? (m.name ?? '') : '';
  const at = name.lastIndexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}

/** ⚠️ SKIPS A `splitOpenShells` SIBLING (`userData.bbDoubleSided`). Its material is a clone of its
 *  source's, so `glbMaterialName` gives the same answer for both, and a `decal#ffffff` that got
 *  split would otherwise have its AprilTag plates and its banner built twice over. */
function meshesUnder(node: THREE.Object3D, material: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  node.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.bbDoubleSided && glbMaterialName(o) === material) out.push(o);
  });
  return out;
}

/** how far a printed quad floats off the surface it is printed on, in. Small enough to be inside
 * the CAD's own 0.0105-in plate; `DECAL_POLYGON_OFFSET` does the rest. */
const MARKING_LIFT_IN = 0.01;

/** `am-1696`'s own outside diameter. */
const STANDOFF_OD_IN = 0.375;
/**
 * How far a standoff's axis sits inside the backstop plate's field-side edge and inside each of
 * its ends. Measured on flower F4: spacer centres at sim (25.868, −68.663) and (20.915, −68.663)
 * against a backstop spanning x 20.650…26.138, y −70.453…−68.398 — 0.265, 0.273 and 0.262 in
 * from the three edges, i.e. one inset, three times.
 */
const STANDOFF_INSET_IN = 0.265;

export interface FieldMarkings {
  /** 4 at the high LOD (one per CELL), 0 at the low one. */
  tagPlates: number;
  /** 4 — the white of the same sticker, coming through the panel from above. */
  tagBleeds: number;
  /** 2 — the ACM panel's two outward faces. */
  banners: number;
  /** 8 — two under each flower's backstop. */
  standoffs: number;
}

const NO_MARKINGS: FieldMarkings = { tagPlates: 0, tagBleeds: 0, banners: 0, standoffs: 0 };

function buildFieldMarkings(
  root: THREE.Object3D,
  hives: { red: FieldHiveGroup; blue: FieldHiveGroup },
  flowers: readonly THREE.Object3D[],
): FieldMarkings {
  const out: FieldMarkings = { tagPlates: 0, tagBleeds: 0, banners: 0, standoffs: 0 };
  const DOWN = new THREE.Vector3(0, 0, -1);
  const UP = new THREE.Vector3(0, 0, 1);

  // ── the four AprilTag clusters, on the underside of each cell floor ──
  for (const alliance of ['red', 'blue'] as const) {
    const tray = hives[alliance].tray;
    for (const mesh of meshesUnder(tray, 'decal#ffffff')) {
      for (const sideSign of [1, -1] as const) {
        const side = sideSign > 0 ? 'north' : 'south';
        // the tray is loaded UN-TILTED (`refTheta` 0), so world y is the cell's own +v here.
        const frame = facetFrame(mesh, (_cx, cy) => Math.sign(cy) === sideSign, DOWN, new THREE.Vector3(0, sideSign, 0));
        if (!frame) continue;
        const ids = TAG_IDS[alliance][side];
        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(frame.width, frame.height),
          decalMaterial(tagClusterTexture(ids, TAG_LABEL[alliance][side], frame.width, frame.height)),
        );
        quad.name = `bb-apriltags:${alliance}:${side}`;
        quad.position.copy(frame.centre).addScaledVector(DOWN, MARKING_LIFT_IN);
        quad.quaternion.copy(frame.quaternion);
        quad.castShadow = false;
        quad.receiveShadow = true;
        tray.attach(quad);
        out.tagPlates++;

        // …and the same sticker seen THROUGH the floor, on the face above it.
        //
        // ⚠️ IT IS THE *SAME RECTANGLE*, FLIPPED — NOT A SECOND `facetFrame` WITH THE NORMAL
        // REVERSED. That was the first spelling and it is wrong: measured on the shipped
        // `field.glb`, the plate's up-facing triangles are a 14.434 × 0.123-in strip, not the
        // 17.001 × 5.001 face the down side gives, because the decimator kept almost nothing of
        // the surface the plate is pressed against. Measuring the top face measures a lip. The
        // rectangle is the one below, lifted to the plate's own top (`bbox.max.z`, so the CAD is
        // still what sets it) and mirrored: +x negated, which is exactly what looking through a
        // translucent panel does to the artwork. See `tagBleedTexture` for why it cannot be read.
        const topZ = new THREE.Box3().setFromObject(mesh).max.z;
        const bleed = new THREE.Mesh(
          new THREE.PlaneGeometry(frame.width, frame.height),
          bleedMaterial(tagBleedTexture(ids, frame.width, frame.height)),
        );
        bleed.name = `bb-apriltag-bleed:${alliance}:${side}`;
        bleed.position.set(frame.centre.x, frame.centre.y, topZ + MARKING_LIFT_IN);
        bleed.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(new THREE.Vector3(sideSign, 0, 0), new THREE.Vector3(0, sideSign, 0), UP),
        );
        bleed.castShadow = false;
        bleed.receiveShadow = false;
        // after the opaque field, like every other transparent surface here — it shares the cell
        // skins' order so two translucent layers over one pixel never fight for it
        bleed.renderOrder = CELL_RENDER_ORDER;
        tray.attach(bleed);
        out.tagBleeds++;
      }
      mesh.visible = false;
    }
  }

  // ── the two banner faces on the shared ACM panel ──
  const sharedFrame = findOptional(root, 'hive_shared/frame');
  if (sharedFrame) {
    for (const mesh of meshesUnder(sharedFrame, 'decal#ffffff')) {
      for (const sideSign of [1, -1] as const) {
        const outward = new THREE.Vector3(0, sideSign, 0);
        const frame = facetFrame(mesh, (_cx, cy) => Math.sign(cy) === sideSign, outward, new THREE.Vector3(0, 0, 1));
        if (!frame) continue;
        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(frame.width, frame.height),
          panelStickerMaterial(bannerTexture(frame.width, frame.height)),
        );
        quad.name = `bb-banner:${sideSign > 0 ? 'north' : 'south'}`;
        quad.position.copy(frame.centre).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quaternion), MARKING_LIFT_IN);
        quad.quaternion.copy(frame.quaternion);
        quad.castShadow = false;
        quad.receiveShadow = true;
        sharedFrame.attach(quad);
        out.banners++;
      }
      mesh.visible = false;
    }
  }

  // ── the eight flower standoffs ──
  let standoffGeo: THREE.BufferGeometry | null = null;
  let standoffMat: THREE.Material | null = null;
  for (let k = 0; k < flowers.length; k++) {
    const backstop = meshesUnder(flowers[k], 'plastic#641c65')[0];
    const topRing = meshesUnder(flowers[k], 'plastic#ffba52')[0];
    if (!backstop || !topRing) continue;
    const plate = new THREE.Box3().setFromObject(backstop);
    const ring = new THREE.Box3().setFromObject(topRing);
    const height = plate.min.z - ring.max.z;
    // the spacer is a 1.000-in part; anything else means the CAD moved and the inset below is a
    // guess about a plate that is no longer there.
    if (!(height > 0.5 && height < 2)) continue;
    if (!standoffGeo) {
      standoffGeo = new THREE.CylinderGeometry(STANDOFF_OD_IN / 2, STANDOFF_OD_IN / 2, height, 12);
      standoffGeo.rotateX(Math.PI / 2); // three builds a cylinder +y up; this field is +z up
      standoffMat = materialFor('plastic', 0xe6e6e6, 'flower');
    }
    // the plate's LONG horizontal axis runs along the wall; the short one crosses it, and its
    // edge nearer the field centre is the flower's field side.
    const long: 'x' | 'y' = plate.max.x - plate.min.x >= plate.max.y - plate.min.y ? 'x' : 'y';
    const short: 'x' | 'y' = long === 'x' ? 'y' : 'x';
    const inner = Math.abs(plate.min[short]) < Math.abs(plate.max[short]) ? plate.min[short] : plate.max[short];
    const across = inner + Math.sign(inner) * STANDOFF_INSET_IN;
    const z = (ring.max.z + plate.min.z) / 2;
    for (const along of [plate.min[long] + STANDOFF_INSET_IN, plate.max[long] - STANDOFF_INSET_IN]) {
      const post = new THREE.Mesh(standoffGeo, standoffMat!);
      post.name = `bb-flower-standoff:${k}`;
      post.position.set(long === 'x' ? along : across, long === 'x' ? across : along, z);
      post.castShadow = true;
      post.receiveShadow = true;
      flowers[k].attach(post);
      out.standoffs++;
    }
  }
  return out;
}

/**
 * Loads one detail level of the CAD field and returns its named parts. `quality` selects
 * `field.glb` (high) or `field-low.glb` (low) — see `docs/biobuzz/plan-3d.md` §8 for the two
 * LODs' size budgets, and the PRINTED FIELD MARKINGS block above for what only the high one gets.
 */
export async function loadFieldGlb(url: string, quality: 'high' | 'low' = 'high'): Promise<FieldGroups> {
  const resolved = resolveGlbUrl(url, quality);
  const gltf: GLTF = await loader().loadAsync(resolved);
  return assembleFieldGroups(gltf.scene, quality);
}

/**
 * Everything `loadFieldGlb` does once the bytes are decoded: materials, normals, the two tray
 * pivot groups, the parts the pipeline mis-filed, and the printed markings.
 *
 * Exported because the RENDER lane parses the shipped `.glb` in Node, where there is no fetch to
 * hand `loadFieldGlb` — and because a check that rebuilt this sequence itself would be checking
 * its own copy. `quality` is `'low'` there: only the HIGH path allocates a canvas.
 */
export function assembleFieldGroups(root: THREE.Group, quality: 'high' | 'low'): FieldGroups {
  // ⚠️ BEFORE `styleScene`, so `computeCreasedNormals` reads the CORRECTED winding and the clear
  // panels can still be recognised by their glTF material names. See the winding header.
  assertRightHandedNodes(root);
  const { stats: winding, open } = repairFieldWinding(root);
  styleScene(root);
  splitOpenShells(root, open);

  const floor = mustFind(root, 'tiles');
  const walls = mustFind(root, 'walls');
  const stations = findOptional(root, 'stations');
  const tape = findOptional(root, 'tape');
  const sharedFrame = findOptional(root, 'hive_shared/frame');

  const hives = {
    red: { frame: mustFind(root, 'hive_red/frame'), tray: buildTrayGroup(root, 'red') },
    blue: { frame: mustFind(root, 'hive_blue/frame'), tray: buildTrayGroup(root, 'blue') },
  };

  const flowers = [0, 1, 2, 3].map((k) => mustFind(root, `flower_${k}`));

  const { braceTris, rockerTris } = reparentTrayBraces(root, hives);
  const markings = quality === 'high' ? buildFieldMarkings(root, hives, flowers) : NO_MARKINGS;

  checkTrayFloorAgreement(hives);

  return { floor, walls, tape, sharedFrame, stations, hives, flowers, root, braceTris, rockerTris, winding, markings };
}

/**
 * The winding repair decides "outward" from a signed volume taken in each geometry's own LOCAL
 * frame, which is only equal to the world answer while every node's world matrix preserves
 * handedness. Every node of both shipped GLBs has determinant +1; a MIRRORED instance would want
 * the opposite winding from the geometry it shares, so this says so out loud rather than rendering
 * one flower inside out.
 */
function assertRightHandedNodes(root: THREE.Object3D): void {
  let mirrored = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.updateWorldMatrix(true, false);
    if (o.matrixWorld.determinant() < 0) mirrored++;
  });
  if (mirrored > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `renderFieldGlb: ${mirrored} mesh node(s) carry a MIRRORED world transform. The winding repair ` +
        `orients shells by a local signed volume and will turn those inside out — see the winding header.`,
    );
  }
}

/** how far the drawn tray floor may sit from the collider floor before the picture and the
 * physics are telling a driver two different things. 0.25 in is the brief's own number; the CAD
 * sheet is 0.020 in thick, so anything real lands far inside it. */
const TRAY_FLOOR_TOLERANCE_IN = 0.25;

/**
 * DEV SELF-CHECK — the drawn tray floor against the collider's. This is the owner's "the balls
 * are on a different plane than the actual bottom of the hive", turned into something that
 * complains on its own the next time it drifts.
 *
 * It RAYCASTS the mesh: a ray dropped down the tray's own local -w axis from inside the cell,
 * and the first surface it meets is compared to `cadCellBox(...).wMin`, the plane the collider's
 * floor slab presents.
 *
 * ⚠️ IT HAS TO BE A RAYCAST, NOT A VERTEX SCAN. A flat CAD face tessellates to its CORNER
 * vertices only — there is not one vertex in the middle of a cell's floor plate — so a "lowest
 * vertex in a window" probe finds the Goal Ribs standing at each END of the cell (they hang
 * 1.5 in below the floor) and reports a ~1-in disagreement that is entirely its own sampling.
 * That is measured, not hypothetical: this check's first version did exactly that, in the app,
 * four times over.
 *
 * `console.warn` only, and only in dev: a wrong floor is a fidelity bug, not a crash, and a
 * player mid-match is not helped by a thrown error.
 */
function checkTrayFloorAgreement(hives: { red: FieldHiveGroup; blue: FieldHiveGroup }): void {
  if (!import.meta.env?.DEV) return;
  const ray = new THREE.Raycaster();
  for (const alliance of ['red', 'blue'] as const) {
    const pivotGroup = hives[alliance].tray;
    pivotGroup.updateWorldMatrix(true, true);
    const toLocal = pivotGroup.matrixWorld.clone().invert();
    for (const sideSign of [1, -1] as const) {
      const box = cadCellBox(alliance, sideSign);
      if (!box) continue;
      const vMid = (box.vMin + box.vMax) / 2;
      // start well inside the cell, off the centreline so the `Basket Base Tube` (a solid rod
      // under the floor at |x| < 0.51) is not what the ray finds first, and drop along local -w.
      const origin = new THREE.Vector3(4, vMid, box.wMin + 6).applyMatrix4(pivotGroup.matrixWorld);
      const down = new THREE.Vector3(0, 0, -1).transformDirection(pivotGroup.matrixWorld).normalize();
      ray.set(origin, down);
      ray.far = 12;
      const hit = ray.intersectObject(pivotGroup, true)[0];
      const side = sideSign > 0 ? 'north' : 'south';
      if (!hit) {
        // eslint-disable-next-line no-console
        console.warn(
          `renderFieldGlb: ${alliance} ${side} cell — nothing under the ray at local (4, ${vMid.toFixed(2)}); ` +
            `the tray mesh may be missing its floor skin.`,
        );
        continue;
      }
      const meshFloorW = hit.point.clone().applyMatrix4(toLocal).z;
      const delta = Math.abs(meshFloorW - box.wMin);
      if (delta > TRAY_FLOOR_TOLERANCE_IN) {
        // eslint-disable-next-line no-console
        console.warn(
          `renderFieldGlb: ${alliance} ${side} cell — the DRAWN floor (local w ${meshFloorW.toFixed(3)}) and the ` +
            `COLLIDER floor (w ${box.wMin.toFixed(3)}) differ by ${delta.toFixed(3)} in, past the ` +
            `${TRAY_FLOOR_TOLERANCE_IN} in tolerance. An element will look like it is floating or sunk. ` +
            `Regenerate with \`npm run field-cad\`; see docs/biobuzz/field-cad-audit.md section 4.`,
        );
      }
    }
  }
}
