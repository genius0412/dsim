import type { EnvironmentId } from './settings';

/**
 * WHAT EVERY SURFACE IS MADE OF — the finish table the `materials: 'physical'` row draws from
 * (`settings.ts`'s NINETEENTH row; the code that applies it is the lazy `scene/renderSurfaces.ts`
 * chunk and its `renderSurface*.ts` helpers).
 *
 * ── WHY A TABLE OF PLAIN NUMBERS, AND WHY HERE ──────────────────────────────────────────────
 * Nothing under `graphics/` may import three (`docs/area/biobuzz.md`; the RENDER lane asserts
 * it), so this file is data a smoke check can read in Node without a canvas, a GL context or the
 * scene chunk: a finish is a colour, a roughness, a metalness, an IOR and a handful of optional
 * lobes, and whether a value moved is a question the RENDER lane can answer by importing it. The
 * physical twins in `scene/renderSurfaceKit.ts` are built FROM these entries and hold no numbers
 * of their own.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────────────────────
 * The 2026-09-27 real-world survey (vendor pages, the BIOBUZZ field guides, handbook IORs),
 * summarised per entry in `source`. `APPROX` marks a value that could not be sourced and is a
 * judgement; everything else names where it came from. Two conventions:
 *   • COLOURS ARE sRGB HEX, and a photo median is NOT an albedo. Vendor photos are studio-lit on
 *     clipped white, so the survey's suggested albedo sits darker than the photo; the `source`
 *     says which one a hex is.
 *   • IOR → F0 is ((n − 1)/(n + 1))², which `finishF0` computes. Every plastic on this field
 *     lands at 0.035–0.052; the IOR is carried anyway because it is free in the shader and is
 *     the one number that separates polycarbonate from polypropylene in a smoke check.
 *
 * ── COLOUR IDENTITY ─────────────────────────────────────────────────────────────────────────
 * ⚠️ `color` IS OPTIONAL, AND ABSENT MEANS "KEEP THE SCENE'S OWN COLOUR". The alliance red and
 * blue (and the owner's `#007be1`, bug 12), the element colours, the cosmetic chassis fill,
 * `TILE_MAT` and every colour a HUD contrast pair was measured against carry MEANING, and the
 * physical row changes what a surface is made of, never which team it belongs to. Those entries
 * therefore carry no `color`; where the survey measured one anyway it is quoted in `source` so
 * the owner can make the call it would take to move it.
 *
 * ── SURFACE DETAIL ──────────────────────────────────────────────────────────────────────────
 * `detail` is PROCEDURAL relief at the part's REAL feature size (`scaleIn` = inches per repeat
 * of the generated tile), sampled triplanar in object or world inches by the kit's shader patch.
 * It is SURFACE FINISH ONLY: a detail never draws a hole, a bolt, a stripe or a letter that is not
 * in the geometry (the wheels' "NOTHING ABOUT THEM IS PAINTED" rule, generalised). `normal` is
 * the slope gain (0 = flat, 1 = the tile's full normalised slope) and `rough` the ± fraction the
 * roughness is modulated by; both are kept small, because a real finish is subtle and a detail
 * that reads at driver distance is a detail that is wrong.
 */

/** the procedural reliefs the kit can generate. Each is one 256² tileable tile; the recipe
 * (octaves, stretch, cell shape) is `scene/renderSurfaceKit.ts`'s, the SIZE is the table's. */
export type DetailKind =
  /** fine isotropic closed-cell speckle — EVA foam, sealed concrete's fines */
  | 'stipple'
  /** low, rounded, isotropic undulation — powder coat and paint "orange peel" */
  | 'orangePeel'
  /** long lines along the part's axis — extrusion die lines on aluminium, HIPS pipe */
  | 'extrusion'
  /** fine isotropic bead-blast / satin anodise micro-texture */
  | 'bead'
  /** a raised pip grid — moulded silicone roller tread */
  | 'pips'
  /** an over/under thread weave — gaffer tape's cotton backing */
  | 'weave'
  /** long, warped lines along the board — hardwood grain */
  | 'grain'
  /** mixed-size flecks — outdoor aggregate */
  | 'speckle'
  /** evenly spaced ridges across the part — FDM layer lines */
  | 'layer';

export interface FinishDetail {
  kind: DetailKind;
  /** inches covered by ONE repeat of the 256² tile — the physical scale of the feature */
  scaleIn: number;
  /** slope gain, 0–1 */
  normal: number;
  /** roughness modulation, ± fraction of the finish's own roughness */
  rough: number;
}

export interface Finish {
  /** sRGB hex. ABSENT = keep the base material's colour (see the header's COLOUR IDENTITY). */
  color?: number;
  roughness: number;
  /** 0 or 1. Nothing real is in between; the old 0.05–0.7 values were neither metal nor paint. */
  metalness: 0 | 1;
  /** dielectrics only; a metal's F0 is its colour */
  ior?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenRoughness?: number;
  /** anisotropic GGX strength along the part's axis. Needs UVs or a tangent attribute (the GLBs
   * have neither): the applier that sets it owns providing one, or the kit leaves it at 0. */
  anisotropy?: number;
  detail?: FinishDetail;
  /** where the numbers came from, or `APPROX: <reason>` */
  source: string;
}

/**
 * THE FINISH TABLE. Keyed by what the part IS, not by where it is: the same black polypropylene
 * is a hive corner casting and a flower's frame foot, and one entry serves both.
 */
export const FINISHES = {
  // ── the field ────────────────────────────────────────────────────────────────────────────
  /** AndyMark am-2499 soft tile, laid smooth side up. The floor keeps its canvas albedo
   * (`TILE_MAT`, HUD-contrast-capped), so no `color`. */
  tile: {
    roughness: 0.85,
    metalness: 0,
    ior: 1.49,
    detail: { kind: 'stipple', scaleIn: 0.5, normal: 0.15, rough: 0.08 },
    source:
      'am-2499 EVA foam, smooth side up (event guide). Roughness 0.8–0.9, IOR ~1.49 handbook EVA. APPROX: stipple 0.004–0.016 in (no close-up found); photo median #91908e is not taken — TILE_MAT carries HUD contrast',
  },
  /** ProGaff red. The GLB strip and the supplemental patch disagree (#ff0000 vs #e02020); the
   * applier keeps the scene's own colour until the owner picks one. */
  tapeRed: {
    roughness: 0.9,
    metalness: 0,
    sheen: 0.3,
    sheenRoughness: 0.8,
    detail: { kind: 'weave', scaleIn: 0.2, normal: 0.12, rough: 0.05 },
    source:
      'ProGaff (event guide §8.1): cotton cloth, rubber adhesive, 11 mil, matte. Vendor photo #fe3432, suggested #e0231e (not taken: colour identity). APPROX: weave 0.4–0.5 mm pitch, sheen 0.3',
  },
  tapeBlue: {
    roughness: 0.9,
    metalness: 0,
    sheen: 0.3,
    sheenRoughness: 0.8,
    detail: { kind: 'weave', scaleIn: 0.2, normal: 0.12, rough: 0.05 },
    source:
      'ProGaff electric blue, as tapeRed. Photo #2476ff, suggested #1868e6 — NOT taken: the scene blue is the owner’s #007be1 (bug 12)',
  },
  /** the perimeter rails (am-2556a) — the proof class of the core pass. A dielectric paint over
   * aluminium: the repo had them as `metal#303030` at metalness 0.7, a dark mirror. */
  powderCoatBlack: {
    color: 0x1b1b1c,
    roughness: 0.5,
    metalness: 0,
    ior: 1.5,
    // ⚠️ 0.02, the robots' coat figure, NOT 0.1. At 0.1 the rail read as TREAD PLATE — a regular
    // raised diamond pattern along its whole length — at a 30 in close-up in the school hall
    // (phase 3, 2026-09-27), for the reason `powderCoatFill` gives: the tile's period shows once
    // its swells are 1–2 px. Real peel is seen only in a sharp reflection.
    detail: { kind: 'orangePeel', scaleIn: 0.4, normal: 0.02, rough: 0.08 },
    source:
      'am-0481 perimeter kit: "powder coated aluminum", Black. Roughness 0.45–0.6 (survey). APPROX: base #1b1b1c, orange peel 1–3 mm wavelength at very low amplitude',
  },
  /** am-1226 corner-hinge rivets */
  rivet: {
    color: 0xb3b3b3,
    roughness: 0.35,
    metalness: 1,
    source: 'am-1226 aluminium rivet, CAD #b3b3b3. APPROX: roughness 0.35',
  },
  /** hive frame legs and top bar: 1×1 in square tube, 0.063 wall, satin mill finish */
  aluminiumTube: {
    color: 0xe6e8e9,
    roughness: 0.35,
    metalness: 1,
    anisotropy: 0.5,
    detail: { kind: 'extrusion', scaleIn: 2, normal: 0.06, rough: 0.12 },
    source:
      'AndyMark hive frame leg/top bar: aluminium square tube, photo shows satin mill finish with lengthwise extrusion streaks. Roughness 0.3–0.4, anisotropy 0.4–0.6 along the axis (survey). Colour is F0, not a photo median: aluminium (0.913, 0.922, 0.924) linear on the standard PBR metal chart, taken ~13 % down for mill-finish oxide (APPROX) → linear ≈ 0.79–0.81. The survey’s #cdd0d3 is a studio photo, which already contains its environment; on this dark mat it rendered the frame near black',
  },
  /** hive top corners (sourced PP), feet, axle and damper holders (ESTIMATE: moulded) */
  blackPolypropylene: {
    color: 0x1e1e1f,
    roughness: 0.55,
    metalness: 0,
    ior: 1.49,
    detail: { kind: 'bead', scaleIn: 0.5, normal: 0.05, rough: 0.1 },
    source:
      'Hive frame top corner: black injection-moulded PP (AndyMark). Feet/holders APPROX: moulded black plastic in the assembly-guide renders. Roughness 0.5–0.6, IOR 1.49',
  },
  /** the ACM panel, fully covered by the BIOBUZZ sticker (field guide §8.1) */
  signVinylPanel: {
    roughness: 0.4,
    metalness: 0,
    ior: 1.5,
    clearcoat: 0.3,
    clearcoatRoughness: 0.25,
    source:
      'ACM 0.12 in under a full printed-vinyl sticker (field guide §8.1). APPROX: roughness 0.4; clearcoat 0.3 / 0.25 stands for the print laminate, a light satin film and not a gloss one',
  },
  /** goal ribs, red and blue — alliance colour kept */
  goalRibPolypropylene: {
    roughness: 0.5,
    metalness: 0,
    ior: 1.49,
    source: 'AndyMark hive cell ribs: polypropylene, colour unpublished (CAD red/blue is a placeholder). Roughness ~0.5, IOR 1.49',
  },
  /** flower rings C (gold) and B/X (black) — opaque moulded polycarbonate */
  flowerRingPolycarbonate: {
    roughness: 0.4,
    metalness: 0,
    ior: 1.585,
    source: 'AndyMark flower top ring C / bottom ring X: polycarbonate. Roughness 0.35–0.45, IOR 1.585',
  },
  /** the flower's green pipe */
  hipsPipe: {
    color: 0x5fa73d,
    roughness: 0.4,
    metalness: 0,
    ior: 1.58,
    detail: { kind: 'extrusion', scaleIn: 3, normal: 0.03, rough: 0.08 },
    source: 'AndyMark HIPS pipe, 1.052 in OD, green; CAD #5fa73d. Roughness ~0.4, IOR ~1.58; faint lengthwise extrusion lines',
  },
  /** the purple corner gusset behind each flower */
  backstopPolycarbonate: {
    roughness: 0.35,
    metalness: 0,
    ior: 1.585,
    source: '"5x5 Purple Polycarbonate Corner Gusset", 0.25 in; CAD #641c65. APPROX: opaque (translucency unpublished)',
  },
  /** the perimeter sheet (am-2582a), 3 mm polycarbonate. The clear-panel shader owns alpha and
   * the veil; a twin changes only what that shader leaves to the material. */
  panelPolycarbonate: {
    roughness: 0.05,
    metalness: 0,
    ior: 1.585,
    source:
      'am-2582a 3 mm (0.118 in) clear polycarbonate, IOR 1.585 (F0 ~0.051), transmission 0.88–0.89 handbook. APPROX: roughness 0.05 new, 0.12–0.25 in a scuffed band 0–5 in above the tile on the inside face',
  },
  /** hive cell skins, 0.020 in PETG with the film peeled */
  cellSkinPetg: {
    roughness: 0.1,
    metalness: 0,
    ior: 1.57,
    source: 'AndyMark hive cell skins: PETG 0.020 in, film peeled both sides (field guide §6.1). IOR 1.57 (F0 0.049), roughness 0.05–0.2',
  },
  /** flower field-wall bracket (sourced nylon); the repo classifies it `metal#303030` */
  blackNylon: {
    color: 0x1f1f1f,
    roughness: 0.55,
    metalness: 0,
    ior: 1.53,
    source: 'AndyMark flower field wall bracket: nylon, black. REV brackets are PA66, 3 mm. Roughness 0.5–0.6',
  },
  /** Blum 970A damper body */
  greyPlastic: {
    roughness: 0.5,
    metalness: 0,
    ior: 1.5,
    source: 'Blum 970A damper, grey plastic, CAD #4d4d4d. APPROX: roughness 0.5',
  },
  /** Churro Lite hex standoffs */
  blackAnodised: {
    color: 0x2a2b2e,
    roughness: 0.4,
    metalness: 1,
    source: 'Churro Lite standoff, black hex extrusion in the renders. APPROX: black anodised aluminium',
  },
  /** the human players' NECTAR holding box (am-5706 Artifact Tray) — the scene's own colours kept */
  trayPolypropylene: {
    roughness: 0.55,
    metalness: 0,
    ior: 1.49,
    detail: { kind: 'bead', scaleIn: 0.5, normal: 0.04, rough: 0.08 },
    source: 'APPROX: am-5706 material unpublished; drawn as moulded polypropylene like the hive castings (roughness 0.5–0.6, IOR 1.49)',
  },

  // ── the scoring elements ─────────────────────────────────────────────────────────────────
  /** POLLEN and NECTAR — colour kept (2D parity and the contrast measurements). */
  elementPolyethylene: {
    roughness: 0.45,
    metalness: 0,
    ior: 1.52,
    source:
      'am-5851/5852 perforated hollow balls; APPROX injection-moulded polyethylene (the pollen matches the floorball spec: 72 mm, 26 holes, PE). Roughness 0.4–0.5, IOR ~1.52',
  },

  // ── robots ───────────────────────────────────────────────────────────────────────────────
  /** goBILDA 1120 U-channel and plates, REV 15 mm extrusion — the robot proof class. */
  aluminiumClearAnodised: {
    color: 0xc4c7ca,
    roughness: 0.4,
    metalness: 1,
    detail: { kind: 'bead', scaleIn: 0.25, normal: 0.05, rough: 0.12 },
    source:
      'goBILDA 1120 series "Clear Anodized" aluminium (photo median #bdbebf, highlight #dcdcdc → suggested #c4c7ca), roughness 0.35–0.45. REV 15 mm 6063-T5 clear anodised. Anisotropy ~0.2 (goBILDA) / 0.4–0.6 (REV) left to the robot applier: robot UVs are per-face box UVs',
  },
  /** an EXTRUDED aluminium part whose axis is known — REV 15 mm extrusion, and the Box Tube's three
   * square tubes. The robot applier reads the axis off the part's geometry (its longest dimension)
   * and gives it a tangent across that axis, so this is the one robot finish that is anisotropic. */
  aluminiumExtrusion: {
    color: 0xc4c7ca,
    roughness: 0.35,
    metalness: 1,
    anisotropy: 0.5,
    detail: { kind: 'extrusion', scaleIn: 2, normal: 0.05, rough: 0.12 },
    source: 'REV 41-1432 15 mm extrusion, 6063-T5, clear anodised, die lines along the axis. Roughness 0.3–0.4, anisotropy 0.4–0.6',
  },
  /** `ALU_DK` parts, as a coated DIELECTRIC — the scene's dark structural tone is kept. Also the
   * other coated greys the robot draws in a tone of their own (`TURRET_RING`, the hood's
   * `TURRET_BARREL`, the `MOTOR` can, the dark axles and the rear bar): each keeps its colour, and
   * what changes is that none of them is a 0.3–0.6 "half metal" any more. */
  darkCoat: {
    roughness: 0.45,
    metalness: 0,
    ior: 1.5,
    clearcoat: 0.2,
    clearcoatRoughness: 0.3,
    detail: { kind: 'orangePeel', scaleIn: 0.4, normal: 0.02, rough: 0.05 },
    source:
      'APPROX: the ALU_DK tone (#39414f) is not a real anodise colour; drawn as a light-clearcoated dark paint so the colour identity holds. A black ANODISE is a sealed oxide (a dielectric) over dyed metal, so a dark dielectric is the closer model than a dark metal either way',
  },
  /** wheel side plates, shafts, the steel in a gearbox */
  steel: {
    color: 0xc4c5c7,
    roughness: 0.4,
    metalness: 1,
    detail: { kind: 'bead', scaleIn: 0.25, normal: 0.04, rough: 0.1 },
    source:
      'Steel F0 ≈ (0.56, 0.57, 0.58) linear (standard PBR metal chart) ≈ sRGB #c4c5c7; roughness 0.35–0.45. NOTE the GripForce mecanum plates are YELLOW-COATED steel (photo #fad309, suggested #eec200, dielectric)',
  },
  /** GripForce 40A rollers, Gecko 30A, omni 50A — the tread colour stays the scene's.
   *
   * ⚠️ NO PIPS. The GripForce roller and the Gecko DO have a pip tread (survey: ~2 mm pitch), and
   * the geometry does not: a pip is 0.08 in, about one pixel at chase distance, so as relief it
   * would only ever shimmer, and drawn larger it would be a feature the part does not have (the
   * wheels' "NOTHING ABOUT THEM IS PAINTED"). The detail is the moulded skin's fine matte grain. */
  siliconeRubber: {
    roughness: 0.7,
    metalness: 0,
    ior: 1.41,
    detail: { kind: 'stipple', scaleIn: 0.3, normal: 0.06, rough: 0.06 },
    source:
      'goBILDA GripForce 40A silicone rollers / Gecko 30A: silicone, IOR ~1.41 (F0 ~0.03), roughness 0.6–0.7. Pip tread (~2 mm pitch, 0.5 mm high, APPROX) deliberately NOT drawn; APPROX: moulded-skin grain',
  },
  /** the cosmetic chassis fill (`chassisFill`) — the colour is the player's, the finish powder coat */
  powderCoatFill: {
    // ⚠️ A MATTE COAT, AND THE REASON IS THE COLOUR. The fill is the player's cosmetic colour, and
    // a satin coat under the room probe turns any dark fill into the room's colour: at 0.5 with a
    // 0.3 / 0.35 clearcoat the default near-black deck measured 123/255 (a brown-grey) at a 30 in
    // close-up in the school hall where standard draws it at 30, and 78 even with the probe's
    // exposure off. A textured (matte) powder coat is the common finish on painted robot sheet and
    // the one that keeps a chosen colour reading as itself; 0.65 with no clearcoat.
    roughness: 0.65,
    metalness: 0,
    ior: 1.5,
    // ⚠️ 0.02, NOT THE RAILS' 0.1. At 0.08 the 0.4 in tile read as a regular diagonal WEAVE on the
    // deck at a 30 in close-up (scene preview, 2026-09-27): its 0.08 in swells land at 1–2 px there,
    // right at the sampling limit, so the tile's own period shows. Real peel is a fraction of a
    // degree of slope and is seen only in a sharp reflection; this is that, and darkCoat matches it.
    detail: { kind: 'orangePeel', scaleIn: 0.4, normal: 0.02, rough: 0.05 },
    source: 'Powder-coated sheet (survey §2 rails, same process), textured (matte) grade. APPROX: roughness 0.65',
  },
  /** REV plastic brackets, moulded hubs, printed-looking housings — and on the robot the Hogback's
   * "Plastic Core", the omni's plastic hub (survey: "plastic hub"), the Box Tube's bearing blocks,
   * pulley and spool, and the claw's servo and jaws. The colour stays the scene's. */
  mouldedNylon: {
    roughness: 0.55,
    metalness: 0,
    ior: 1.53,
    detail: { kind: 'bead', scaleIn: 0.5, normal: 0.04, rough: 0.08 },
    source: 'REV 15 mm plastic brackets: moulded nylon PA66, 3 mm, black (#1f1f1f photo). Roughness 0.5–0.6',
  },
  /** timing belts, flat belts. Where the scene MERGED a belt with its pulleys into one buffer (the
   * swerve pod's drive, the shooter's belt) the whole part takes this finish: splitting them is a
   * second draw call per pod for a pulley a camera sees as a dark disc. */
  rubberBelt: {
    roughness: 0.7,
    metalness: 0,
    ior: 1.5,
    source: 'APPROX: neoprene/urethane belt, matte',
  },
  /** the front bar and the deck arrow — matte white paint, NEVER emissive (owner, 2026-09-27) */
  markingPaint: {
    roughness: 0.6,
    metalness: 0,
    ior: 1.5,
    source: 'Survey rec. 1: matte white ~#eeeeee at roughness 0.6 (colour kept: BB_FRONT_INK). No emissive, on any tier',
  },
  /** the robot number sign: printed vinyl, matte so the digits never glare */
  signVinyl: {
    roughness: 0.7,
    metalness: 0,
    ior: 1.5,
    source: 'APPROX: matte printed vinyl; no clearcoat over the digits',
  },
  /** FDM-printed parts (no robot part is one yet; here for the day one is) */
  printedPla: {
    roughness: 0.5,
    metalness: 0,
    ior: 1.46,
    detail: { kind: 'layer', scaleIn: 0.08, normal: 0.1, rough: 0.1 },
    source: 'APPROX: 0.2 mm (0.008 in) layer lines, 0.02–0.05 mm relief; PLA roughness 0.45–0.6, PETG 0.25–0.35',
  },

  // ── venue floors ─────────────────────────────────────────────────────────────────────────
  // The venue applier (`scene/renderSurfaceVenue.ts`) PAINTS each floor's albedo around the
  // environment's own `floor` colour, every channel normalised to a mean of exactly that colour, so
  // none of these carries a `color`: the venue's "a tint, not a colour" rule is the RENDER lane's.
  /** gym and school-hall: finished maple strip flooring under a gloss polyurethane. The base is the
   * sealed wood; the COAT is what reflects, and it reflects the room probe's lamp grid — the whole
   * reason a gym floor reads as one. The coat's DIRECT sun term is dropped in an enclosed venue
   * (the applier says why). */
  mapleFloor: {
    roughness: 0.55,
    metalness: 0,
    ior: 1.5,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    detail: { kind: 'grain', scaleIn: 12, normal: 0.04, rough: 0.15 },
    source:
      'Survey (scenery §4): maple strips 2.25 in (MAPLE_STRIP_IN), polyurethane coat clearcoat 0.8–1 at 0.1–0.2. APPROX: boards 12–72 in, end joints racked ≥ 6 in from the next strip’s (common strip-floor practice)',
  },
  /** room and arena: a sheet vinyl sports floor, rolls heat-welded at the seams */
  sportsVinyl: {
    roughness: 0.65,
    metalness: 0,
    ior: 1.5,
    detail: { kind: 'stipple', scaleIn: 1, normal: 0.05, rough: 0.08 },
    source:
      'Survey (scenery §4): vinyl sports floor, roughness ~0.65. APPROX: 72 in (6 ft) rolls — the common US sheet width — with a welded seam line, ±2 % shade roll to roll, a fine printed pepper and emboss',
  },
  /** workshop: a sealed slab. `roughness` is the MEAN of the applier's roughness map: the sealer's
   * sheen is patchy (0.45–0.8), glossier where the trowel burnished the slab darker. */
  sealedConcrete: {
    roughness: 0.62,
    metalness: 0,
    ior: 1.5,
    detail: { kind: 'stipple', scaleIn: 6, normal: 0.06, rough: 0.15 },
    source:
      'Survey (scenery §4): sealed concrete, roughness 0.55–0.75, mottle and saw-cut joints. Joints every 144 in (CONCRETE_BAY_IN): slab joint spacing is ~24–36× the thickness, 10–15 ft for a 5-in slab (ACI 360R guidance). APPROX: 1/8 in cuts, trowel mottle ±6 %',
  },
  /** overcast, sunset, night: weathered asphalt with the surface aggregate exposed */
  outdoorAggregate: {
    roughness: 0.9,
    metalness: 0,
    ior: 1.5,
    detail: { kind: 'speckle', scaleIn: 4, normal: 0.12, rough: 0.08 },
    source:
      'Survey (scenery §4): fine aggregate speckle. APPROX: a 3/8 in (9.5 mm) surface-course mix, exposed stones 0.1–0.35 in across over darker binder; roughness 0.9',
  },
  /** the three studios: floor paint, carried up the cyclorama cove as one surface */
  studioPaint: {
    roughness: 0.8,
    metalness: 0,
    ior: 1.5,
    source: 'Survey (scenery §4): a painted cyclorama floor needs no texture (the base mottle stays). APPROX: roughness 0.8',
  },

  // ── venue walls and structure (seen out of focus: material only, no detail) ─────────────────
  /** hall and arena walls, the columns against them */
  venueWallPaint: {
    roughness: 0.85,
    metalness: 0,
    ior: 1.5,
    source: 'APPROX: eggshell latex or epoxy paint on block or board, the usual gym/hall wall',
  },
  /** hall and arena ceilings */
  venueCeiling: {
    roughness: 0.95,
    metalness: 0,
    ior: 1.5,
    source: 'APPROX: flat-painted roof deck or acoustic tile',
  },
  /** the lighting grid over the field */
  venueSteelPaint: {
    roughness: 0.6,
    metalness: 0,
    ior: 1.5,
    source: 'APPROX: primed and painted structural steel (a painted truss is a dielectric, not a metal)',
  },
} as const satisfies Record<string, Finish>;

export type FinishId = keyof typeof FINISHES;

/**
 * WHAT A ROBOT PART IS, as `scene/renderRobots.ts` tags it where the part is built (`cast(mesh,
 * family)`, REQUIRED, so no part can be added without one) — and the finish each family is drawn
 * in under the physical row. Short words rather than the finish ids because the tags ship in the
 * SCENE chunk, one per part, which every 3D player downloads whether the row is on or not; the
 * mapping (and so every number) ships only in the lazy `surfaces` chunk. The tag is inert: the
 * standard materials never read it.
 */
export const ROBOT_FAMILY_FINISH = {
  /** clear-anodised goBILDA channel and plates, brackets, arms, braces, the dumper */
  alu: 'aluminiumClearAnodised',
  /** an extruded aluminium part with a known axis — the Box Tube's tubes */
  extr: 'aluminiumExtrusion',
  /** bare steel — the mecanum's side plates, the flywheel shaft */
  steel: 'steel',
  /** the coated dark/grey structural tones (`ALU_DK`, `TURRET_RING`, `TURRET_BARREL`, `MOTOR`) */
  dark: 'darkCoat',
  /** the cosmetic chassis fill: skin, deck, end plates, a `bold` sign frame */
  fill: 'powderCoatFill',
  /** silicone/rubber treads — wheel rollers and tyres, intake rollers and flaps, the flywheel */
  rubber: 'siliconeRubber',
  /** moulded plastic — wheel cores and hubs, bearing blocks, the claw, pulleys and spools */
  nylon: 'mouldedNylon',
  /** belts, and the pulleys merged into them */
  belt: 'rubberBelt',
  /** the front bar and deck arrow — matte paint, never emissive */
  paint: 'markingPaint',
  /** the ROBOT SIGNS and the deck decal */
  vinyl: 'signVinyl',
} as const satisfies Record<string, FinishId>;

export type RobotFamily = keyof typeof ROBOT_FAMILY_FINISH;

/** the finish every environment's venue ground is drawn in. Keyed by environment id rather than
 * carried on `VenueSpec` so `environments.ts` (whose entries the RENDER lane pins value for
 * value) is untouched by the physical row. */
export const VENUE_FLOOR_FINISH: Record<EnvironmentId, FinishId> = {
  room: 'sportsVinyl',
  arena: 'sportsVinyl',
  gym: 'mapleFloor',
  workshop: 'sealedConcrete',
  overcast: 'outdoorAggregate',
  sunset: 'outdoorAggregate',
  night: 'outdoorAggregate',
  'cyc-light': 'studioPaint',
  'cyc-dark': 'studioPaint',
  'school-hall': 'mapleFloor',
  'monochrome-studio': 'studioPaint',
};

/** one maple strip's face width, inches — the standard 2-1/4 in gym strip */
export const MAPLE_STRIP_IN = 2.25;
/** the shortest distance between end joints in neighbouring strips ("racking"), inches */
export const MAPLE_RACK_IN = 6;
/** one sheet-vinyl roll's width, inches (6 ft) */
export const VINYL_ROLL_IN = 72;
/** a slab bay between saw-cut control joints, inches (12 ft) */
export const CONCRETE_BAY_IN = 144;

/** a dielectric's normal-incidence reflectance from its IOR. */
export function finishF0(ior: number): number {
  return ((ior - 1) / (ior + 1)) ** 2;
}
