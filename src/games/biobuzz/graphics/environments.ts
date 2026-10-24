/**
 * ENVIRONMENTS — the procedural surrounds, one fetched CC0 HDRI and (since 2026-10-10) five
 * PHOTOGRAPHED VENUES (`docs/biobuzz/plan-3d.md` §4.5; `PhotoVenue` below), as DATA. No three.js here: `scene/renderEnvironment.ts` is what loads one, and the
 * Graphics section and the Contributors page both read this list, neither of which may pull the
 * renderer chunk in.
 *
 * ── WHY THE EIGHT ADDED ON 2026-09-21 ARE ALL PROCEDURAL ───────────────────────────────────
 * The owner asked for "more choices for the 3d field background". Every one of them is PAINTED
 * — an equirectangular canvas a few hundred pixels across, built once per id and kept — rather
 * than a ninth, tenth, eleventh photographed room. Three reasons, in order of how much they
 * bind:
 *   • A DOWNLOAD IS A COST THE PLAYER PAYS TO LOOK AT SOMETHING. The two HDRIs are 1.6 MB each
 *     and the picker prints their size for that reason; eight more would be 13 MB of scenery
 *     behind a settings row. A painted dome is a few hundred bytes of source.
 *   • THE TIER LADDER. `envLighting` is OFF on Low and Medium, and an HDRI that is not lighting
 *     anything is a download for a backdrop — so those two tiers had no surround to pick at all.
 *     A painted dome costs nothing to fetch, so `renderEnvironment.ts` still paints it with the
 *     image-based lighting off and only the light-gathering map is dropped. The whole list is
 *     live on every tier now, which it was not.
 *   • LEGIBILITY IS A SETTABLE NUMBER, NOT A PROPERTY OF A PHOTOGRAPH. Each of these carries
 *     its own `rig` — sun direction and colour, both hemisphere terms, the exposure — chosen so
 *     the alliance reds/blues, the yellow POLLEN and the blue NECTAR keep their separation and
 *     the mat never goes so dark or so bright that a shadow or the shot-path line disappears.
 *     A photographed room's cast is whatever the photographer's afternoon was.
 *
 * ── THE RULES §4.5 SETS, AND HOW EACH IS KEPT ──────────────────────────────────────────────
 * "fetched on demand as a 1k `.hdr`"          — `url` is Poly Haven's own CDN, hit by
 *                                               `RGBELoader` the first time an id is selected.
 * "browser-cached"                            — `dl.polyhaven.org` answers with
 *                                               `Cache-Control: max-age=14400`, so a second
 *                                               pick inside four hours is a memory-cache hit
 *                                               and no request at all. Measured 2026-09-18.
 * "never in any chunk"                        — no `import`, no base64. The fetched HDRI is
 *                                               only ever in the browser's HTTP cache; the
 *                                               photographed venues' files are DERIVED copies
 *                                               under `public/venues/` (`PhotoVenue`), served
 *                                               like any other static file.
 * "attribution on the Contributors page"      — `src/contributors.ts` renders `THIRD_PARTY`,
 *                                               which is built from this list, so an entry
 *                                               added here is credited by construction rather
 *                                               than by somebody remembering.
 *
 * ── AND THE ONE CLIENT WHERE "FETCHED ON DEMAND" MEANS "NEVER" ─────────────────────────────
 * A Discord Activity is served behind a CSP that admits only dsim's two Activity URL Mappings,
 * so a Poly Haven `.hdr` cannot be fetched there AT ALL — and until 2026-10-10 `school-hall`, High's
 * and Ultra's default column, was one (it is a same-origin photographed venue now, which the embed
 * loads like the rest of the site). `canFetchHdri` / `environmentDefFor` (below) answer that up front and hand the
 * entry's painted `fallback` to the renderer instead, rather than letting every scene build make
 * a request the browser refuses. Nothing is bundled and nothing is stored: see those two.
 *
 * ── LICENCE ────────────────────────────────────────────────────────────────────────────────
 * Every Poly Haven asset is CC0 1.0 (public domain dedication): no attribution is REQUIRED.
 * It is given anyway, in full, with the author split the API reports — photography and
 * processing are often different people and crediting only the first is the usual way that
 * gets wrong.
 */

import { inDiscordActivity } from '../../../net/discordActivity';
import type { EnvironmentId } from './settings';

/**
 * THE LIGHT RIG ONE ENVIRONMENT ASKS FOR — plain numbers, because this file may not import
 * three.js and `scene/renderEnvironment.ts`'s `applyEnvironmentRig` is what turns them into
 * light objects.
 *
 * ⚠️ **THE FIELD'S OWN COLOURS ARE FIXED AND EVERY VALUE HERE MOVES THEM.** The tiles, the tape,
 * the alliance reds/blues, the yellow POLLEN and the blue NECTAR are drawn at constants (§4.5,
 * and `draw.ts`'s note on why an element's fill does not theme), so the ONLY thing that can push
 * them out of their contrast pairs is the lighting. Hence: no rig tints the key light past a
 * warm/cool cast a camera would white-balance out, and the hemisphere GROUND term stays near
 * neutral everywhere — a saturated bounce is what turns a red NECTAR on a red tray into one
 * shape. The measured numbers are in the RENDER lane and in this session's report.
 */
export interface EnvironmentRig {
  /** hemisphere fill: the term above the horizon, and the bounce off the floor. */
  hemiSky: number;
  hemiGround: number;
  /** hemisphere intensity WITH image-based lighting, and WITHOUT — with the IBL off it is most
   * of the ambient term there is, so it has to carry more. Same split `renderCore.ts` makes for
   * the shared default. */
  hemiIbl: number;
  hemiNoIbl: number;
  /** the key light's position, field inches. Only its DIRECTION matters (a `DirectionalLight`),
   * but it is written as a position because that is what three takes and what the shadow
   * camera is sized against. */
  sun: readonly [number, number, number];
  sunColor: number;
  sunIntensity: number;
  /** ACES exposure for this place (`renderer.toneMappingExposure`). */
  exposure: number;
}

/**
 * ONE STOP of the painted dome: how far down from the zenith (0 = straight up, 0.5 = the
 * horizon, 1 = straight down) and the colour there. Linearly interpolated between stops.
 */
export type SkyStop = readonly [number, number];

/**
 * THE PAINTED SURROUND — what `renderEnvironment.ts` draws onto an equirectangular canvas, which
 * is then BOTH `scene.background` AND (when image-based lighting is on) the source the PMREM
 * mip chain is generated from. One texture for both is the point: a surround that lit the field
 * from a hall while showing a sunset would read as a compositing mistake, which is the same
 * reason the HDRI path sets the background to its own map.
 */
export interface EnvironmentLook {
  /** the vertical gradient, zenith to nadir. At least two stops. */
  sky: readonly SkyStop[];
  /** a soft bright disc — a sun, or a bank of ceiling lamps. `az` is degrees around the dome and
   * `el` degrees above the horizon; `r` is its angular radius. */
  lamp?: { az: number; el: number; r: number; color: number };
  /** a bright BAR ringing the dome at one elevation: a lighting truss, a row of strip lights, a
   * floodlight bank. `h` is its angular height in degrees. */
  truss?: { el: number; h: number; color: number };
  /** a dark toothed band below the horizon — stands, bleachers, shelving. Read as a silhouette
   * once the background's own blur is applied, which is all a surround has to do. */
  silhouette?: { top: number; bottom: number; color: number; alpha: number; teeth: number };
  /** a deterministic star field in the upper dome. */
  stars?: boolean;
  /** how far the BACKGROUND is blurred and dimmed. A painted dome is already soft, so it takes
   * less of both than a photograph does (`BG_BLUR`/`BG_INTENSITY` in the renderer are the
   * HDRI's own, unchanged). */
  blur: number;
  intensity: number;
}

/**
 * ── THE VENUE (2026-09-21) ─────────────────────────────────────────────────────────────────
 *
 * ⚠️ **A BLURRED DOME IS NOT A PLACE, AND THAT IS WHAT THE OWNER REPORTED** ("The graphic
 * lighting environment is too basic. Make it render an actual environment instead of blurry
 * lights"). Everything above this comment describes the SURROUND as an image at infinity: a
 * `scene.background` texture, painted or photographed, drawn with `backgroundBlurriness` 0.16 –
 * 0.30 so its own coarse structure reads as atmosphere rather than as a picture on a wall. Three
 * things follow from that, and all three were visible in the captures:
 *   • **it has no parallax.** A background texture is sampled by view DIRECTION, so it does not
 *     move when the camera does. Orbiting the field slides the mat across a gradient that never
 *     shifts, which is the single strongest cue that there is nothing out there.
 *   • **it has no horizon.** The camera looks DOWN at the field, so most of the frame samples the
 *     dome's lower half — which is one gradient stop to the next. A `gym` orbit shot is a brown
 *     wash from edge to edge with the field slab floating in the middle of it.
 *   • **and on the CAD field path there is no floor beyond the perimeter at all.** The procedural
 *     `bb-room` (`scene/renderField.ts`) is built by the CONSTANTS fallback only; `glbFieldToHandles`
 *     never adds it, so the shipping field hangs in the clear colour with its own alliance-area
 *     tape running off into the void.
 *
 * So each environment now also describes a VENUE: real geometry around the field — a ground that
 * reaches past the perimeter, walls, a ceiling with fixtures in it, trussing, seating, or an open
 * horizon — built by `scene/renderVenue.ts` and lit by the SAME `rig`. The dome stays: it is still
 * the light-gathering map, it is still what a robot's metal reflects, and outdoors it is still the
 * sky above the horizon the ground now draws.
 *
 * ⚠️ **THE FIELD IS UNTOUCHED AND MUST STAY THE BRIGHTEST, MOST SATURATED THING ON SCREEN.**
 * Every colour below is desaturated and sits clear of the mat's own band — a venue that competes
 * with the field for the eye is a worse bug than an empty one. Same standing constraint as the
 * rig's (`EnvironmentRig`'s warning): the tiles, tape, alliance reds/blues, POLLEN and NECTAR are
 * drawn at constants, so anything that changes what is AROUND them has to leave their pairs alone.
 */
export type VenueKind =
  /** four walls, a flat ceiling with light fittings in it: a practice room, a gym, a school hall. */
  | 'hall'
  /** a dark house, a lighting truss overhead and seating banks down both sides. */
  | 'arena'
  /** a seamless cyclorama — a coved floor-to-wall sweep and softboxes above it. */
  | 'studio'
  /** no ceiling: ground to a horizon, with the dome's own sky above it. */
  | 'outdoor';

export interface VenueSpec {
  kind: VenueKind;
  /** the ground beyond the perimeter. */
  floor: number;
  /** the far vertical surfaces — hall walls, the cyclorama sweep, the arena's house. */
  wall: number;
  /** structure: trusses, columns, stand risers, floodlight masts, the horizon's own solids. */
  trim: number;
  /** the fixtures' emissive colour and how hot they read. `power` 0 means no fittings at all. */
  lamp: number;
  lampPower: number;
  /**
   * half-extent of the room in inches (the ground reaches further; outdoors this is the
   * distance to the horizon line). The field's own half-extent is 70.674.
   *
   * ⚠️ **AN ENCLOSED VENUE MUST BE WIDER THAN THE CAMERAS CAN REACH, AND 290 IS NOT.** The
   * first `workshop` was a 290-in shop, which is the size a shop actually is — and the orbit
   * camera zooms to `ORBIT_RADIUS_MAX` 620 (`scene/renderCameras.ts`), so it stood OUTSIDE its
   * own walls. The shell is `BackSide`, so from outside there is nothing to see: the picture
   * became the far half of the room viewed through a wall that had vanished. Every hall, arena
   * and studio therefore starts at `VENUE_MIN_HALF` (`scene/renderVenue.ts`, which clamps this
   * as a guard rather than trusting the numbers below), and character comes from the CEILING
   * height, the colours and what is in the room — a low dark 660-in shop still reads as a shop.
   * Going ABOVE a ceiling degrades gracefully to a cutaway and needs no guard; going outside a
   * WALL does not.
   */
  half: number;
  /** ceiling height, inches. Ignored by `outdoor`. */
  ceil: number;
  /** seating banks down the two long sides (`high` detail only). */
  stands?: boolean;
  /** a painted panel/court grid on the ground — a sports floor rather than a poured slab. */
  gridded?: boolean;
}

/**
 * ── THE PHOTOGRAPHED VENUES (2026-10-10) ───────────────────────────────────────────────────
 *
 * Owner: "Please add actual good quality scenes for backgrounds." Every surround above is a
 * procedural box room; the two photographs this list had (`school-hall`, `monochrome-studio`) only
 * lit the field, because the venue geometry hid them. A `photo` entry SHOWS its photograph: a
 * Poly Haven CC0 panorama, re-encoded for display by `scripts/venues/derive.cjs` into
 * `public/venues/`, and projected by `scene/renderPhotoVenue.ts` onto a box the shape of the
 * room it was taken in — the floor at the capture height below the lens, the walls where the
 * real walls are — so the floor has the right scale and the right parallax from every camera.
 *
 * ⚠️ **SAME ORIGIN, UNLIKE `hdri`.** The files are this site's own, so they load inside a Discord
 * Activity (whose CSP refuses `dl.polyhaven.org`) and never need a painted stand-in for that
 * reason. `fallback` exists for a transient failure only (`ibl`'s fetch, offline). This reverses
 * the old "nothing under `public/`" rule for DERIVED files, and only for them: the photographs as
 * published (16k–24k, 25–850 MB) are never committed.
 */
export interface PhotoRoom {
  /** the walls, as signed distances from the capture point along x and y, inches (`x0`, `y0` < 0) */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** the ceiling above the floor, inches */
  ceil: number;
}

export interface PhotoVenue {
  /** the backdrop, 4096 × 2048 (High and up) and 2048 × 1024 (Low, Medium, small GPUs) — paths
   * relative to the app's base URL, resolved by the renderer (the Electron build's base is `./`) */
  backdrop: string;
  backdropLow: string;
  /** the light-gathering map: a small linear `.hdr` box-filtered from the same 4k source. The
   * backdrop cannot do this job — it is 8-bit, and some of these rooms keep most of their light in
   * a few very hot texels (`derive.cjs`, ENCODING). */
  ibl: string;
  /** bytes of each, for the picker's note and the docs */
  bytes: { backdrop: number; backdropLow: number; ibl: number };
  /** the `gain` the backdrop was encoded with (`scripts/venues/venues.cjs`); the shader divides it
   * back out. Must match the files, and the RENDER lane reads both to check it. */
  gain: number;
  /** a linear multiplier on the decoded photograph — the dim that keeps the field the brightest
   * thing on screen */
  intensity: number;
  /** how much of the photograph's own colour is kept, 0–1 (the same rule: the field is the most
   * saturated thing on screen) */
  saturation: number;
  /** the lens above the floor, inches — the number that sets the floor's scale */
  height: number;
  /** the box the photograph is projected onto */
  room: PhotoRoom;
  /** how dark the field's shadow lands on the photographed floor, 0–1 */
  shadow: number;
  /**
   * FURNITURE NEAR THE FIELD THAT THE FLOOR PLANE DRAWS FLAT, if any is left in the files — what it
   * is and where. A box stands up the floor and the walls and nothing else, so anything standing
   * between the lens and a wall is drawn where its ray meets the floor: a stretched, flat smear
   * across it (the events hall's banquet chairs were painted out in the derive for this). A row
   * that carries this is a pick, never a preset column's default — the default is what most
   * players see, and High's is every replay export's (2026-10-11, the RENDER lane pins it).
   */
  furniture?: string;
  /** the room as its own geometry (`PhotoLayers`), which draws nothing flat; the box above is the
   * fallback when these files cannot load */
  layers?: PhotoLayers;
  /** the painted entry whose dome lights the field should `ibl` fail to load. Same rule as
   * `hdri.fallback`: painted, and the same venue kind. */
  fallback: EnvironmentId;
  /** the Poly Haven asset the files are derived from, for the credit line */
  slug: string;
  page: string;
  authors: readonly { name: string; role: string }[];
  license: 'CC0 1.0';
  licenseUrl: string;
}

/** a rectangle of a photographed room's floor, field inches */
export interface PhotoFloor {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * A PHOTOGRAPHED VENUE AS ITS OWN GEOMETRY (2026-10-24; `renderPhotoVenue.ts`, THE LAYERED ROOM).
 * Derived from the backdrop by `scripts/venues/` (MoGe-2 depth, OneFormer furniture, LaMa
 * inpainting; see that README): the room with its furniture painted out, the furniture alone, and
 * the meshes they are drawn on. High and up load `bg` and `fg`, Low and Medium `bgLow` and `fgLow`
 * (`bbPhotoDetail`); the box's `backdrop` is fetched only if one of these fails.
 */
export interface PhotoLayers {
  /** the backdrop with the furniture inpainted out, 4096 × 2048 and 2048 × 1024 */
  bg: string;
  bgLow: string;
  /** the ORIGINAL backdrop, rows `fgRows` only, 4096 and 2048 wide */
  fg: string;
  fgLow: string;
  /** the room and furniture meshes (`scripts/venues/pack.ts`) */
  mesh: string;
  /** the panorama's rows `fg` holds, as shares of its height, top first */
  fgRows: readonly [number, number];
  /** where the room's floor is the photographed floor plane, when that is not the whole room: the
   * field's shadow stops at its edge (the school hall's stage ends 80 in out, over an auditorium
   * 30 in lower) */
  floor?: PhotoFloor;
  bytes: { bg: number; bgLow: number; fg: number; fgLow: number; mesh: number };
}

export interface EnvironmentDef {
  id: EnvironmentId;
  /** the picker's label. */
  name: string;
  /** what it does to the picture, in the one line the picker has room for. Present only where
   * it names a real trade-off — `docs/ui-standard.md` §8 deletes a description that restates
   * its own label, and "Gym" does not need a sentence about gyms. */
  note: string;
  /** the light rig this place asks for. Every entry carries one; the three that predate the
   * 2026-09-21 set carry `BASE_RIG`, which IS `renderCore.ts`'s shared default, so none of them
   * changed a pixel when this field was added. */
  rig: EnvironmentRig;
  /** the real geometry around the field. Every entry carries one — an environment with no venue
   * is the empty-void picture this field was reported for. */
  venue: VenueSpec;
  /** the painted dome. Absent means the surround comes from somewhere else: three's own
   * `RoomEnvironment` for `room` (whose background is the THEMED letterbox colour), the fetched
   * image for an `hdri` entry, or the photograph for a `photo` one. */
  look?: EnvironmentLook;
  /** a PHOTOGRAPHED venue (see `PhotoVenue`). Its `venue` above is still built: it is what stands
   * while the photograph loads, and what stays if it cannot. */
  photo?: PhotoVenue;
  /** absent for a procedural entry: it is generated, it has no author and it costs nothing. */
  hdri?: {
    /** the 1k `.hdr` on Poly Haven's CDN. Verified 2026-09-18: 200, `Access-Control-Allow-Origin: *`. */
    url: string;
    /**
     * THE PROCEDURAL ENTRY TO RENDER INSTEAD WHEN THIS ONE CANNOT BE FETCHED — see
     * `environmentDefFor` below, and `scene/renderEnvironment.ts`'s failure path.
     *
     * Every `hdri` entry carries one, and it must be an id whose own def is PAINTED (`look`)
     * rather than a second fetched one, or the substitution has somewhere else to fall. The
     * old failure path applied `'room'`, which is three's `RoomEnvironment` ambient behind the
     * THEMED letterbox colour — the flattest surround in the list and the least like either of
     * the two photographs it was standing in for. A stand-in chosen per entry costs nothing
     * (it is painted) and lands in the same kind of place: a school hall reads as a school
     * gym, a monochrome studio as the dark cyclorama.
     */
    fallback: EnvironmentId;
    /** bytes, from the Poly Haven files API — printed in the picker so a player on a phone
     * plan knows what a pick costs before making it. */
    bytes: number;
    /** the asset's own page, for the credit line. */
    page: string;
    /** as the API reports them, role and all. */
    authors: readonly { name: string; role: string }[];
    license: 'CC0 1.0';
    licenseUrl: string;
  };
}

/** Poly Haven's 1k HDR path. One template rather than three literals, so a mistyped slug is a
 * 404 on one asset instead of a URL that points at somebody else's file. */
const PH_HDR = (slug: string): string => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${slug}_1k.hdr`;
const PH_PAGE = (slug: string): string => `https://polyhaven.com/a/${slug}`;
const PH_LICENSE = 'https://polyhaven.com/license';

/** a photographed venue's three files (`scripts/venues/derive.cjs` names them), with their sizes */
const PHOTO_FILES = (
  id: string,
  backdrop: number,
  backdropLow: number,
  ibl: number,
): Pick<PhotoVenue, 'backdrop' | 'backdropLow' | 'ibl' | 'bytes'> => ({
  backdrop: `venues/${id}-4k.webp`,
  backdropLow: `venues/${id}-2k.webp`,
  ibl: `venues/${id}-ibl.hdr`,
  bytes: { backdrop, backdropLow, ibl },
});

/** a photographed venue's layer files (`scripts/venues/meshes.py` and `pack.ts` name them), with
 * the furniture's rows and the sizes (`sync-env.mjs` writes both) */
const PHOTO_LAYERS = (
  id: string,
  fgRows: readonly [number, number],
  bytes: PhotoLayers['bytes'],
  floor?: PhotoFloor,
): PhotoLayers => ({
  bg: `venues/${id}-bg-4k.webp`,
  bgLow: `venues/${id}-bg-2k.webp`,
  fg: `venues/${id}-fg-4k.webp`,
  fgLow: `venues/${id}-fg-2k.webp`,
  mesh: `venues/${id}-room.glb`,
  fgRows,
  ...(floor ? { floor } : {}),
  bytes,
});

/** the credit block of a photographed venue */
const PH_CREDIT = (
  slug: string,
  authors: readonly { name: string; role: string }[],
): Pick<PhotoVenue, 'slug' | 'page' | 'authors' | 'license' | 'licenseUrl'> => ({
  slug,
  page: PH_PAGE(slug),
  authors,
  license: 'CC0 1.0',
  licenseUrl: PH_LICENSE,
});

/**
 * THE LENS HEIGHT the photographs were taken at, inches — Poly Haven's tripod, MEASURED PER VENUE
 * (2026-10-24), because the rooms were read off the photographs in lens heights: a wrong lens sizes
 * the whole room wrong against the true-scale field and gives wrong parallax from every eye off it.
 * Each is read off gnomonic crops of its own backdrop: an object of known height h on the field's
 * floor, its base α_b and top α_t below the horizon, gives h / (1 − tan α_t / tan α_b).
 *
 * This 63 is for the venues the measurement leaves within 2 % of it: the events hall's tables (0.76 m,
 * two of them: 63.2 and 63.3 in), the quad's two steel doors (2.032 m leaves on a walkway 0.145 lens
 * heights up, measured off its curb: 62.9 and 63.8). The school hall's references disagree by more
 * than the change (the covered grand piano over its near leg 62.4–64.5, the wing door's leaf 65.5 at
 * an old 1981 mm, 67.1 at 2032 mm) and the hangar's are too far out and too irregular to read (a
 * bench, a table, a motorcycle wheel: 59–81), so both keep it. The COURT is measured to a few tenths
 * and carries its own (`height` on its row): it was this number's source, read as 1.64 and 1.54 m off
 * the netball lines, and averaged to 1.6.
 */
const PHOTO_LENS_IN = 63;

/**
 * THE RIG THE THREE ORIGINAL ENVIRONMENTS ARE LIT BY — the same numbers `renderCore.ts` declares
 * as `SCENE_*`, repeated here as data so a `rig` is not optional on one entry and present on the
 * others. It is a COPY on purpose, for the reason `readBackdropColor`'s fallback literal is one:
 * `graphics/` may not import anything under `scene/`, and the RENDER lane asserts the two agree
 * rather than leaving it to a habit.
 *
 * Every value was tuned against the match view in the 2026-09-18 playtest; `renderCore.ts` has
 * the reasoning on each constant, and the robot-builder preview still lights from THOSE, so a
 * build cannot come out one colour in the garage and another on the field.
 */
export const BASE_RIG: EnvironmentRig = {
  hemiSky: 0xffffff,
  hemiGround: 0x4b525c,
  hemiIbl: 1.3,
  hemiNoIbl: 2.1,
  sun: [60, -80, 140],
  sunColor: 0xffffff,
  sunIntensity: 1.9,
  exposure: 1.2,
};

export const BB_ENVIRONMENTS: readonly EnvironmentDef[] = [
  {
    id: 'room',
    name: 'Practice room',
    note: 'Generated, nothing to download',
    rig: BASE_RIG,
    // THE DEFAULT ON LOW AND MEDIUM, and therefore the venue most players will ever see. A
    // light neutral room with a sports floor: the brightest mat in the list (0.097) wants a
    // ground it can sit ON rather than a darker one it floats above.
    venue: { kind: 'hall', floor: 0x555b63, wall: 0x676d76, trim: 0x828892, lamp: 0xf4f7ff, lampPower: 1.1, half: 660, ceil: 288, gridded: true },
  },
  {
    /**
     * A COMPETITION HOUSE: the audience side dark, the light coming off a truss ring. This is the
     * one environment whose surround is DARKER than the field, and that is the whole shot — an
     * FTC division field at a championship is a bright island in a dark hall, and it is the most
     * flattering the mat ever looks. The rig has to carry all of it (the dome contributes almost
     * no ambient), so the sun is the brightest of the eleven and steeper than the default, which
     * is also what an overhead truss does.
     */
    id: 'arena',
    name: 'Competition arena',
    note: 'Dark house, truss overhead',
    rig: {
      hemiSky: 0xdfe8ff,
      hemiGround: 0x2a2f38,
      hemiIbl: 2,
      hemiNoIbl: 2.5,
      sun: [40, -60, 170],
      sunColor: 0xf2f6ff,
      sunIntensity: 2.1,
      exposure: 1.38,
    },
    // THE CHAMPIONSHIP DIVISION SHOT: a dark house, a truss ring overhead and seating down
    // both sides. The one venue DARKER than the mat, which is the whole reason it exists.
    venue: { kind: 'arena', floor: 0x23272d, wall: 0x151920, trim: 0x3b414a, lamp: 0xd8e6ff, lampPower: 1.9, half: 760, ceil: 360, stands: true },
    look: {
      sky: [
        [0, 0x0a0d12],
        [0.34, 0x141a22],
        [0.5, 0x1d2530],
        [0.62, 0x161c25],
        [1, 0x0d1117],
      ],
      truss: { el: 22, h: 3.2, color: 0xd8e6ff },
      silhouette: { top: 0.52, bottom: 0.68, color: 0x080b10, alpha: 0.85, teeth: 26 },
      blur: 0.18,
      intensity: 0.85,
    },
  },
  {
    /**
     * THE ROOM MOST PRACTICE ACTUALLY HAPPENS IN. A wood floor is the reason it is worth having
     * as well as the school hall HDRI: the bounce is warm and it comes from BELOW, which lifts
     * the underside of a chassis and the inside of a hive cell in a way no overhead rig does.
     * The hemisphere ground term is the warmest of the eleven for exactly that, and it is still
     * well short of a saturated brown — see `EnvironmentRig`'s own warning.
     */
    id: 'gym',
    name: 'School gym',
    note: 'Warm ceiling light off a wood floor',
    rig: {
      hemiSky: 0xfff6e6,
      hemiGround: 0x6b5c45,
      hemiIbl: 1.25,
      hemiNoIbl: 2,
      sun: [50, -70, 150],
      sunColor: 0xfff4e0,
      sunIntensity: 1.85,
      exposure: 1.15,
    },
    // A WOOD FLOOR AND BLEACHERS, because that is the room most practice happens in. The
    // ground is the warmest surface in the list and still well short of a saturated brown —
    // it is the bounce the rig's `hemiGround` already describes, now visible.
    venue: { kind: 'hall', floor: 0x8a6e49, wall: 0xa49d8c, trim: 0x6d6354, lamp: 0xfff4e0, lampPower: 1.2, half: 680, ceil: 312, stands: true, gridded: true },
    look: {
      sky: [
        [0, 0xe8e4d8],
        [0.3, 0xd8d2c2],
        [0.5, 0xbfae8e],
        [0.6, 0xa98b60],
        [1, 0x8d7049],
      ],
      lamp: { az: 90, el: 68, r: 26, color: 0xfff8e8 },
      silhouette: { top: 0.5, bottom: 0.58, color: 0x4a3a28, alpha: 0.28, teeth: 14 },
      blur: 0.22,
      intensity: 0.8,
    },
  },
  {
    /**
     * A TEAM'S OWN SHOP — dark walls, a concrete floor and two rows of strip lights, which is
     * what the `truss` band is here. It is the darkest surround after the arena and the night
     * sky, and the one with the warmest key; the pair is deliberate, because a warm key on a
     * neutral-dark ground is where the yellow POLLEN reads at its very best.
     */
    id: 'workshop',
    name: 'Workshop',
    note: 'Strip lights over dark walls',
    rig: {
      hemiSky: 0xffeedd,
      hemiGround: 0x3a3a3e,
      hemiIbl: 1.95,
      hemiNoIbl: 2.45,
      sun: [70, -50, 130],
      sunColor: 0xffefd6,
      sunIntensity: 1.8,
      exposure: 1.35,
    },
    // A TEAM'S OWN SHOP: small, low, concrete, dark walls, two rows of strip lights. The
    // half-extent is a THIRD of the arena's — a shop you can practise in is a small room,
    // and the near walls are most of what makes it read as one.
    venue: { kind: 'hall', floor: 0x494c51, wall: 0x2c2e33, trim: 0x53575f, lamp: 0xfff0d0, lampPower: 1.7, half: 660, ceil: 200 },
    look: {
      sky: [
        [0, 0x2b2b2e],
        [0.36, 0x3a3a3e],
        [0.5, 0x47433d],
        [0.64, 0x2f2d2b],
        [1, 0x232326],
      ],
      truss: { el: 42, h: 4.5, color: 0xfff0d0 },
      silhouette: { top: 0.5, bottom: 0.66, color: 0x18181b, alpha: 0.62, teeth: 18 },
      blur: 0.2,
      intensity: 0.85,
    },
  },
  {
    /**
     * OUTDOORS UNDER CLOUD — the one environment with almost no key. The sun is the WEAKEST of
     * the eleven and the hemisphere the strongest, because that is what an overcast sky is: a
     * dome of light and barely a shadow. It is also the most forgiving background there is for
     * reading a field, which is why it is in the list at all.
     */
    id: 'overcast',
    name: 'Overcast day',
    note: 'Flat daylight, soft shadows',
    rig: {
      hemiSky: 0xeef4fa,
      hemiGround: 0x7c828a,
      hemiIbl: 1.5,
      hemiNoIbl: 2.3,
      sun: [30, -40, 180],
      sunColor: 0xffffff,
      sunIntensity: 1.3,
      exposure: 1.1,
    },
    // OUTDOORS, FLAT LIGHT: ground to a far horizon with a low treeline on it, and the dome's
    // own overcast sky above. No ceiling and no fittings — the sky IS the fixture.
    venue: { kind: 'outdoor', floor: 0x6c7168, wall: 0x9aa3a8, trim: 0x565d52, lamp: 0, lampPower: 0, half: 1700, ceil: 0 },
    look: {
      sky: [
        [0, 0xd6dee6],
        [0.36, 0xc6d0da],
        [0.5, 0xb4bcc2],
        [0.58, 0xa3a8ac],
        [1, 0x8e9296],
      ],
      blur: 0.28,
      intensity: 0.8,
    },
  },
  {
    /**
     * A WARM KEY FROM ONE SIDE, low enough to throw a long shadow and no lower — see the two
     * measurements this entry is the reason for.
     *
     * ⚠️ **THE SUN IS AT 40°, NOT AT THE 15° A SUNSET ACTUALLY IS.** The first pass put it there
     * (`[-150, -60, 42]`) and MEASURED the whole mat at a rendered luminance of **0.0018** — pure
     * black, against 0.046 for the shipping `school-hall` and 0.097 for the room. A grazing key
     * lands only `cos(15°) = 0.25` of itself on a horizontal floor, the perimeter walls then put
     * the first 40 in of every edge in shadow, and the tile grid, the element shadows and the
     * shot-path line all go with it. Raising the ambient instead does NOT fix it: hemisphere
     * intensity 1.15 → 2.6 → 3.2 moved the mat only 0.0018 → 0.0102 → 0.0110, because the floor's
     * albedo is dark and the ambient term is a small share of it. The key's own ANGLE was the
     * whole variable. At 40° the shadows are still visibly long and the mat measures in the band
     * every other environment is in.
     *
     * The other risk is the one the colour carries: a deep orange key collapses the yellow POLLEN
     * and the red NECTAR toward one hue. `sunColor` is therefore held at a light amber rather
     * than the sunset the DOME is painted as — the sky carries the mood and the key carries the
     * legibility, and they are allowed to disagree.
     */
    id: 'sunset',
    name: 'Sunset',
    note: 'Warm key, long shadows',
    rig: {
      hemiSky: 0xffd9b0,
      hemiGround: 0x3a3140,
      hemiIbl: 2.2,
      hemiNoIbl: 2.7,
      sun: [-130, -55, 120],
      sunColor: 0xffd2a0,
      sunIntensity: 2,
      exposure: 1.3,
    },
    // The same open ground under the warm dome. The horizon solids are the DARKEST thing in
    // this environment on purpose: a silhouette against a lit sky is what a sunset looks like,
    // and it is also what keeps the warm cast out of the field's own colours.
    venue: { kind: 'outdoor', floor: 0x6a5e51, wall: 0x8d6d5b, trim: 0x3c3444, lamp: 0, lampPower: 0, half: 1700, ceil: 0 },
    look: {
      sky: [
        [0, 0x2a3a5e],
        [0.3, 0x55527a],
        [0.44, 0xa8705c],
        [0.5, 0xd98a52],
        [0.56, 0x9a6448],
        [1, 0x7d6253],
      ],
      lamp: { az: 200, el: 6, r: 5, color: 0xffd9a0 },
      blur: 0.2,
      intensity: 0.85,
    },
  },
  {
    /**
     * FLOODLIT UNDER A DARK SKY. Structurally the arena's twin — a dark dome and a bright ring —
     * and kept as its own entry because the two read completely differently: the arena's ring is
     * a warm-white truss close overhead and the light falls off, while this is a cool bank far
     * out and the field is evenly lit. The stars are the only decoration in the whole list that
     * does nothing for the lighting; they are what says "outdoors" rather than "a dark room".
     */
    id: 'night',
    name: 'Night',
    note: 'Floodlit under a dark sky',
    rig: {
      hemiSky: 0xc8d8ff,
      hemiGround: 0x1a1f2a,
      hemiIbl: 2.3,
      hemiNoIbl: 2.8,
      sun: [20, -50, 190],
      sunColor: 0xdfe9ff,
      sunIntensity: 2,
      exposure: 1.38,
    },
    // FLOODLIT, OUTDOORS: four masts at the field's corners with lit heads, over dark ground.
    // The masts are the only fittings in the list that stand IN the picture rather than hanging
    // above it, which is what tells a player this is a car park and not a dark room.
    venue: { kind: 'outdoor', floor: 0x32373e, wall: 0x0f141d, trim: 0x161b24, lamp: 0xdfe9ff, lampPower: 2.4, half: 1700, ceil: 0 },
    look: {
      sky: [
        [0, 0x050912],
        [0.34, 0x0a1020],
        [0.5, 0x141c2e],
        [0.62, 0x0b101a],
        [1, 0x070a10],
      ],
      truss: { el: 30, h: 2.2, color: 0xbcd0ff },
      stars: true,
      blur: 0.16,
      intensity: 0.9,
    },
  },
  {
    /**
     * A NEUTRAL CYCLORAMA, BRIGHT — the studio the photographed one already is, generated, and
     * with no cast at all. It is the environment to pick when the question is what a BUILD looks
     * like rather than what a match feels like, and it is the brightest surround in the list:
     * the dark mat sits on a near-white ground, which is the highest contrast the field ever has
     * against its own letterbox.
     */
    id: 'cyc-light',
    name: 'Light studio',
    note: 'Bright neutral surround',
    rig: {
      hemiSky: 0xffffff,
      hemiGround: 0xa8adb4,
      hemiIbl: 1.2,
      hemiNoIbl: 2,
      sun: [60, -80, 140],
      sunColor: 0xffffff,
      sunIntensity: 1.7,
      exposure: 1.12,
    },
    // A REAL CYCLORAMA — a coved floor-to-wall sweep with no corner in it, which is the one
    // thing a gradient cannot fake: the cove catches the key light as a soft band and that
    // band is what says "a studio" rather than "a white screen".
    venue: { kind: 'studio', floor: 0xdfe1e5, wall: 0xedeff2, trim: 0xc6cad0, lamp: 0xffffff, lampPower: 1.3, half: 660, ceil: 300 },
    look: {
      sky: [
        [0, 0xf4f5f6],
        [0.4, 0xe9eaec],
        [0.5, 0xdfe1e4],
        [0.7, 0xd4d7da],
        [1, 0xcfd2d6],
      ],
      lamp: { az: 120, el: 55, r: 30, color: 0xffffff },
      blur: 0.3,
      intensity: 0.78,
    },
  },
  {
    /**
     * THE SAME CYCLORAMA, DARK. Its own entry rather than a theme switch on the one above, for
     * the reason `src/theme.ts` keeps the field out of the theme entirely: which surround flatters
     * a field is a framing choice, not a light/dark preference, and a player on a dark UI may
     * well want the bright one. The rig is the base rig with a slightly lifted ground term, so
     * the difference between the two really is only the ground the field is standing on.
     */
    id: 'cyc-dark',
    name: 'Dark studio',
    note: 'Dark neutral surround',
    rig: {
      hemiSky: 0xffffff,
      hemiGround: 0x33373d,
      hemiIbl: 1.95,
      hemiNoIbl: 2.45,
      sun: [60, -80, 140],
      sunColor: 0xffffff,
      sunIntensity: 1.95,
      exposure: 1.35,
    },
    // The same sweep, dark. Its softboxes are the brightest thing above the field, which is
    // the only light a dark studio has.
    venue: { kind: 'studio', floor: 0x1c1e22, wall: 0x24262b, trim: 0x34383e, lamp: 0xf0f4ff, lampPower: 1.6, half: 660, ceil: 300 },
    look: {
      sky: [
        [0, 0x24262a],
        [0.4, 0x1c1e22],
        [0.5, 0x17191c],
        [0.7, 0x141619],
        [1, 0x121417],
      ],
      lamp: { az: 120, el: 55, r: 30, color: 0xf0f4ff },
      blur: 0.3,
      intensity: 0.85,
    },
  },
  {
    /**
     * A SCHOOL HALL WITH A WOODEN FLOOR AND A STAGE — chosen over the two fitness-gym sets
     * (`gym_01`, `crossfit_gym`) and the climbing gym because it is the room an FTC event is
     * actually held in: a high ceiling, overhead fluorescents, and a floor bright enough to
     * bounce light back under a chassis. A weights room lights a robot from one wall.
     *
     * PHOTOGRAPHED SINCE 2026-10-10: the field stands on the stage the panorama was taken from,
     * with the auditorium behind it (turned 180° so the seats are on the far side from the
     * audience camera, `+y`). The stage is small — 7.6 lens heights wide, its front edge under 2
     * out — so the stage-level box takes the auditorium too (12.0 deep in all). The auditorium
     * floor is a metre below the stage, and one floor plane draws it about 0.6 × as deep as it is. The key comes from the auditorium
     * lights, which is where the photograph's own light comes from (`fieldlight`: az 75°, el 35°).
     *
     * ⚠️ NOT A DEFAULT SINCE 2026-10-11 (`furniture` below): the stage edge is 81 in out on +y,
     * 9 in past the field's wall (measured off the photograph: 37.7° below the lens), the seats
     * start just beyond it, and from both driver cameras a third of the frame is seats drawn flat
     * across the floor. Painting ~300 of them out leaves nothing true to fill with, and a +y wall
     * at the stage edge would leave the cameras 51 in of room on that side. High, Ultra and the
     * replay export render in the events hall instead.
     */
    id: 'school-hall',
    name: 'School hall',
    note: 'On the stage, the auditorium behind, 1.5 MB',
    rig: {
      hemiSky: 0xfff6e8,
      hemiGround: 0x5e5444,
      hemiIbl: 1.3,
      hemiNoIbl: 2.1,
      sun: [22, 116, 120],
      sunColor: 0xfff1dc,
      sunIntensity: 1.9,
      exposure: 1.2,
    },
    // what stands while the photograph loads, and if it cannot: the procedural hall
    venue: { kind: 'hall', floor: 0x8a7352, wall: 0xaaa392, trim: 0x796f5e, lamp: 0xfff8ec, lampPower: 1.1, half: 700, ceil: 330, gridded: true },
    photo: {
      ...PHOTO_FILES('school-hall', 726_594, 221_352, 430_592),
      gain: 1.3,
      intensity: 0.9,
      saturation: 0.85,
      height: PHOTO_LENS_IN,
      room: { x0: -233, x1: 246, y0: -208, y1: 551, ceil: 260 },
      shadow: 0.4,
      layers: PHOTO_LAYERS('school-hall', [0.162109375, 0.703125], { bg: 571_412, bgLow: 175_712, fg: 380_916, fgLow: 126_790, mesh: 86_044 }, { x0: -233, x1: 246, y0: -208, y1: 80 }),
      furniture: 'the auditorium: ~300 seats from the stage edge (81 in out on +y) to the back wall',
      // `gym` is the same ROOM painted: a hall venue, a wood floor, bleachers, overhead fittings
      fallback: 'gym',
      ...PH_CREDIT('school_hall', [
        { name: 'Dimitrios Savva', role: 'Photography' },
        { name: 'Jarod Guest', role: 'Processing' },
      ]),
    },
  },
  {
    /**
     * AN EVENTS HALL — brick walls, a steel roof on trusses, a concrete floor: the shape of a
     * venue an FTC qualifier is held in. Turned −20° so its long axis runs along x, the drivers'
     * line of sight; the end walls are 9.7 and 10.6 lens heights out, the sides 5.1 and 5.8.
     * The tables and chairs on the +y side are the one thing a single floor plane cannot draw
     * standing up.
     */
    id: 'events-hall',
    name: 'Events hall',
    note: 'Brick walls, steel roof, concrete floor, 1.6 MB',
    rig: {
      hemiSky: 0xf2f6ff,
      hemiGround: 0x5f5c56,
      hemiIbl: 1.3,
      hemiNoIbl: 2.1,
      sun: [27, -127, 109],
      sunColor: 0xf4f8ff,
      sunIntensity: 1.9,
      exposure: 1.2,
    },
    venue: { kind: 'hall', floor: 0x77736c, wall: 0xb2aca2, trim: 0x6a645c, lamp: 0xf4f8ff, lampPower: 1.1, half: 700, ceil: 330 },
    photo: {
      ...PHOTO_FILES('events-hall', 785_528, 249_240, 427_861),
      gain: 1,
      intensity: 0.6,
      saturation: 0.85,
      height: PHOTO_LENS_IN,
      room: { x0: -611, x1: 668, y0: -318, y1: 365, ceil: 300 },
      shadow: 0.4,
      layers: PHOTO_LAYERS('events-hall', [0.177734375, 0.568359375], { bg: 684_238, bgLow: 213_540, fg: 433_312, fgLow: 150_396, mesh: 42_640 }),
      fallback: 'gym',
      ...PH_CREDIT('events_hall_interior', [
        { name: 'Dimitrios Savva', role: 'Photography' },
        { name: 'Jarod Guest', role: 'Processing' },
      ]),
    },
  },
  {
    /**
     * A HANGAR — a big shed with a clear floor, a light aircraft at one end and the open door at
     * the other. Turned 90° so that axis is x, the drivers' line of sight. Daylight through the
     * side windows (`fieldlight`: az 64°, el 20°), which the key follows at 40°.
     */
    id: 'hangar',
    name: 'Hangar',
    note: 'Daylight through high windows, 2.0 MB',
    rig: {
      hemiSky: 0xfff6ec,
      hemiGround: 0x625a4e,
      hemiIbl: 1.3,
      hemiNoIbl: 2.1,
      sun: [61, 115, 109],
      sunColor: 0xfff2e0,
      sunIntensity: 1.9,
      exposure: 1.2,
    },
    venue: { kind: 'hall', floor: 0x7d7465, wall: 0xa59d8c, trim: 0x6d6354, lamp: 0xfff4e0, lampPower: 1.1, half: 760, ceil: 360 },
    photo: {
      ...PHOTO_FILES('hangar', 1_329_858, 344_362, 430_444),
      gain: 1.5,
      intensity: 0.65,
      saturation: 0.85,
      height: PHOTO_LENS_IN,
      room: { x0: -737, x1: 882, y0: -441, y1: 441, ceil: 410 },
      shadow: 0.4,
      layers: PHOTO_LAYERS('hangar', [0.376953125, 0.556640625], { bg: 1_148_178, bgLow: 307_092, fg: 341_228, fgLow: 95_796, mesh: 53_484 }),
      fallback: 'workshop',
      ...PH_CREDIT('small_hangar_01', [{ name: 'Sergej Majboroda', role: 'All' }]),
    },
  },
  {
    /**
     * AN OUTDOOR COURT at the end of the day — a fenced netball court, so the field stands on a
     * painted sports surface whose lines give the eye an exact scale. The box is the fence: 11.4 /
     * 12.4 lens heights out along x, 6.1 / 5.8 along y.
     *
     * THE LENS IS 64.6 in, MEASURED OFF THE LINES (2026-10-24): two courts are painted on it, a
     * tennis court (white) and a netball court (yellow), centred on the lens. Each pair of parallel
     * lines either side of it, read where it crosses the axis, puts the lens at its span over the
     * sum of the two lines' cotangents: the service lines (12.75 m centre to centre) 64.8, the
     * baselines (23.72) 64.9, the singles sidelines (8.18) 64.4, the doubles (10.92) 64.6, the netball
     * sidelines (15.20) 64.5 and its third lines (10.12) 64.3. The first reading's 1.54 m does not
     * reproduce off any pair; the surface tilts 0.2–0.5 % (drainage), which moves the far lines a few
     * tenths and no more. The room was rescaled from 63 about the lens (× 1.0254,
     * `scripts/venues/rescale-lens.ts`).
     *
     * The sun is low in the photograph (12°) and the key is raised to 40° for the RENDER lane's 25°
     * rule (`sunset`'s measurement).
     */
    id: 'court',
    name: 'Outdoor court',
    note: 'Evening sky over a sports court, 1.1 MB',
    rig: {
      hemiSky: 0xe4edff,
      hemiGround: 0x3f4a46,
      hemiIbl: 1.3,
      hemiNoIbl: 2.1,
      sun: [-16, -129, 109],
      sunColor: 0xffecd2,
      sunIntensity: 1.9,
      exposure: 1.2,
    },
    venue: { kind: 'outdoor', floor: 0x45574f, wall: 0x8c9890, trim: 0x4b5a50, lamp: 0, lampPower: 0, half: 1700, ceil: 0 },
    photo: {
      ...PHOTO_FILES('court', 438_074, 116_978, 375_051),
      gain: 2.5,
      intensity: 1,
      saturation: 0.8,
      height: 64.6,
      room: { x0: -736, x1: 801, y0: -394, y1: 374, ceil: 2051 },
      shadow: 0.45,
      layers: PHOTO_LAYERS('court', [0.341796875, 0.560546875], { bg: 394_290, bgLow: 107_070, fg: 260_832, fgLow: 69_588, mesh: 37_320 }),
      fallback: 'overcast',
      ...PH_CREDIT('netball_court', [
        { name: 'Dimitrios Savva', role: 'Photography' },
        { name: 'Jarod Guest', role: 'Processing' },
      ]),
    },
  },
  {
    /**
     * A COVERED SCHOOL QUAD — paving under a steel canopy, open to the courtyard on one side. The
     * pavers are a second exact scale on the ground, the canopy keeps the light soft.
     */
    id: 'quad',
    name: 'School quad',
    note: 'Paving under a canopy, 2.1 MB',
    rig: {
      hemiSky: 0xfff8ee,
      hemiGround: 0x645a4a,
      hemiIbl: 1.3,
      hemiNoIbl: 2.1,
      sun: [77, -92, 120],
      sunColor: 0xfff4e2,
      sunIntensity: 1.9,
      exposure: 1.2,
    },
    venue: { kind: 'outdoor', floor: 0x8a7d66, wall: 0x9aa39a, trim: 0x5a6152, lamp: 0, lampPower: 0, half: 1700, ceil: 0 },
    photo: {
      ...PHOTO_FILES('quad', 1_436_898, 436_626, 449_016),
      gain: 1.1,
      intensity: 0.65,
      saturation: 0.8,
      height: PHOTO_LENS_IN,
      room: { x0: -630, x1: 662, y0: -372, y1: 384, ceil: 190 },
      shadow: 0.4,
      layers: PHOTO_LAYERS('quad', [0.33984375, 0.5625], { bg: 1_271_930, bgLow: 380_350, fg: 342_984, fgLow: 115_444, mesh: 41_700 }),
      fallback: 'overcast',
      ...PH_CREDIT('school_quad', [
        { name: 'Dimitrios Savva', role: 'Photography' },
        { name: 'Jarod Guest', role: 'Processing' },
      ]),
    },
  },
  {
    /**
     * A NEUTRAL STUDIO, and neutral is the requirement rather than a preference: the tiles and
     * the tape keep fixed on-field colours so the HUD's contrast pairs hold (§4.5), and a
     * warm- or blue-cast studio would push every one of them without any of the tokens
     * changing. `monochrome_studio_02` is white softboxes over a dark ceiling — the light is
     * colourless by construction, so what it adds is shape, not a tint.
     */
    id: 'monochrome-studio',
    name: 'Photo studio',
    note: 'Neutral softboxes, 1.6 MB',
    rig: BASE_RIG,
    // Softboxes over a neutral sweep — the geometry of the photograph it is lit by, so the
    // reflections on a frame rail and the room they appear to come from agree.
    venue: { kind: 'studio', floor: 0x3b3e43, wall: 0x494d53, trim: 0x5b6068, lamp: 0xffffff, lampPower: 1.5, half: 660, ceil: 300 },
    hdri: {
      url: PH_HDR('monochrome_studio_02'),
      // the painted twin of the photograph: `cyc-dark` is softboxes over a dark neutral sweep,
      // which is what `monochrome_studio_02` IS. `cyc-light` is the same geometry with the
      // brightness inverted, so it is the wrong one of the pair.
      fallback: 'cyc-dark',
      bytes: 1_562_415,
      page: PH_PAGE('monochrome_studio_02'),
      authors: [{ name: 'Grzegorz Wronkowski', role: 'All' }],
      license: 'CC0 1.0',
      licenseUrl: PH_LICENSE,
    },
  },
];

export function environmentDef(id: EnvironmentId): EnvironmentDef {
  return BB_ENVIRONMENTS.find((e) => e.id === id) ?? BB_ENVIRONMENTS[0];
}

/**
 * ⚠️ **CAN THIS CLIENT FETCH A CROSS-ORIGIN ASSET AT ALL?** — false inside a Discord Activity,
 * where the answer is decided before any request is made and can never change.
 *
 * The activity is served through Discord's proxy at `<app-id>.discordsays.com`, whose CSP admits
 * only the hosts that have a configured Activity URL Mapping. dsim has exactly two (`/` → the
 * client, `/gs` → the game server — `src/net/discordActivity.ts`), and `dl.polyhaven.org` is not
 * one of them, so an `.hdr` fetched from there is refused by the browser before it leaves.
 *
 * ── WHY THIS WAS A DEFAULT-PATH BUG AND NOT AN EDGE (until 2026-10-10, see above) ──────────
 * `school-hall` was the `environment` column on BOTH High and Ultra (`GFX_PRESETS`), an ordinary
 * desktop lands on one of those from `graphics/auto.ts`'s first guess, and the warm-up governor
 * steps a laptop UP into them about two seconds into a match. So in the embed this fired on
 * essentially every 3D match, and it fired AGAIN on every scene build and every graphics change,
 * because only a SUCCESS is cached.
 *
 * ── AND WHY THE EXISTING FALLBACK WAS NOT ENOUGH ───────────────────────────────────────────
 * Nothing broke visibly: `renderEnvironment.ts` caught the failure, applied three's
 * `RoomEnvironment` and pushed an event line. But the line is invisible in a networked match
 * (`src/game.ts` drains `netEvents`, not `world.events`, and `onQualityEvent` writes the latter —
 * a separate bug), the room is the flattest surround on the list, and the picker went on offering
 * both photographs with their download sizes. A blocked request per scene build plus a console
 * warning is not a cost worth paying for a picture that cannot arrive.
 *
 * ⚠️ IT IS `inDiscordActivity()`, NOT `discordGroup()`. This is a question about the DOCUMENT —
 * which CSP is over it — not about which party the player is in, and that file's own header says
 * the party can legitimately be unknown while the embed is certain. See its warning.
 *
 * A TRANSIENT failure (offline, a captive portal, a proxy that rewrites `.hdr` to HTML) is NOT
 * this predicate's business: it stays the loader's, which now remembers the ids that failed so it
 * does not re-ask on every scene build either.
 */
export function canFetchHdri(): boolean {
  return !inDiscordActivity();
}

/**
 * ⚠️ **THE DEF THIS CLIENT WILL ACTUALLY RENDER — use this everywhere under `scene/`.**
 *
 * `environmentDef` is the declared table: id → the row as written, which is what the picker and
 * the Contributors page want. This is the RESOLVED one: the same row, unless it is a fetched
 * entry on a client that cannot fetch, in which case it is that entry's painted `fallback`.
 *
 * Resolving it HERE rather than in the loader is what keeps the picture self-consistent. Three
 * separate things read an environment row — the light `rig`, the `venue` geometry
 * (`scene/renderVenue.ts`) and the surround texture (`scene/renderEnvironment.ts`) — and before
 * this they disagreed in the embed: the rig and the venue were the school hall's while the map
 * quietly became the practice room's, so the geometry was a school hall lit by a generic box.
 * One resolver, one answer, all three in step.
 *
 * It is deliberately NOT applied to the STORED setting. Nothing is rewritten, so a player who
 * picked `school-hall` still has `school-hall` stored and gets the photograph back the moment
 * they open the same build outside the embed. (Storage is per-ORIGIN anyway — the activity's
 * `discordsays.com` bucket is not `playdsim.com`'s — so the two can never collide.)
 */
export function environmentDefFor(id: EnvironmentId): EnvironmentDef {
  const def = environmentDef(id);
  if (!def.hdri || canFetchHdri()) return def;
  return environmentDef(def.hdri.fallback);
}

/**
 * The environments worth OFFERING on this client — the whole list, minus any fetched entry whose
 * bytes can never arrive. The picker's tiles state a download size ("1.7 MB") and the hint below
 * them says a choice with a size "downloads once"; both are false in the embed, where picking one
 * silently renders its painted stand-in instead. Nothing else about the list changes.
 */
export function pickableEnvironments(): readonly EnvironmentDef[] {
  return canFetchHdri() ? BB_ENVIRONMENTS : BB_ENVIRONMENTS.filter((e) => !e.hdri);
}

/** every environment whose light-gathering map is fetched CROSS-ORIGIN from Poly Haven. */
export function hdriEnvironments(): EnvironmentDef[] {
  return BB_ENVIRONMENTS.filter((e) => e.hdri);
}

/** every PHOTOGRAPHED venue (same-origin files under `public/venues/`). */
export function photoEnvironments(): EnvironmentDef[] {
  return BB_ENVIRONMENTS.filter((e) => e.photo);
}

/** WHO TO CREDIT for an environment that is somebody's photograph — a fetched HDRI or a derived
 * venue — or null for a generated one. What the Contributors page renders, per entry. */
export function environmentCredit(e: EnvironmentDef): {
  page: string;
  authors: readonly { name: string; role: string }[];
  license: string;
  licenseUrl: string;
  use: string;
} | null {
  if (e.photo) {
    const p = e.photo;
    return { page: p.page, authors: p.authors, license: p.license, licenseUrl: p.licenseUrl, use: 'BIOBUZZ 3D venue backdrop and lighting' };
  }
  if (e.hdri) {
    const h = e.hdri;
    return { page: h.page, authors: h.authors, license: h.license, licenseUrl: h.licenseUrl, use: 'BIOBUZZ 3D environment lighting' };
  }
  return null;
}

/** every environment that is somebody's photograph — what the Contributors page credits. */
export function creditedEnvironments(): EnvironmentDef[] {
  return BB_ENVIRONMENTS.filter((e) => environmentCredit(e) !== null);
}

/** the ids in the order the picker shows them — the one place the list's ORDER is read, so the
 * settings coercer and the RENDER lane cannot fall out of step with the array above. */
export const BB_ENVIRONMENT_IDS: readonly EnvironmentId[] = BB_ENVIRONMENTS.map((e) => e.id);
