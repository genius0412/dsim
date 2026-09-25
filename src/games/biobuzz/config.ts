/**
 * BIOBUZZ (FTC 2026–27) — field + element constants.
 *
 * ── WHERE THE NUMBERS COME FROM: THE V1 KICKOFF MANUAL ──────────────────────
 * `BIOBUZZ_Competition_Manual_V1` (2026-09-12, 173 pages) is the source, distilled in
 * `docs/biobuzz/manual-distilled.md` and `docs/biobuzz-reference.md`. Section 9 (ARENA) gives
 * the field, the HIVES, the FLOWERS and the zones; Section 10 the elements, match periods and
 * point values; Section 11 the game rules (G304 start, the fouls `penalties.ts` enforces);
 * Section 12 the robot:
 *  • R102 — STARTING CONFIGURATION is limited to an 18-inch CUBE.
 *  • R104 — there is NO ROBOT weight limit.
 *  • R105.A — once the match starts a ROBOT may expand, but must stay within an
 *    18 × 24 × 29 in (tall) sizing volume (`BB_PRISM` / `BB_PRISM_NARROW`).
 * Some shapes are still owner CAD or figure reads rather than printed dimensions (the FLOWER
 * foot, the LOADING ZONE tape edge), and every robot MECHANISM number is the sim's own model:
 * the manual constrains robots, it does not describe one.
 *
 * ── THE APPROX CONVENTION ───────────────────────────────────────────────────
 * Every constant whose value is NOT printed in the V1 manual carries an `APPROX` comment naming
 * what it was derived from. That is not decoration: someone greps `APPROX` in this file and
 * that grep IS the work list for the next manual revision or field test. A number without the
 * marker is a number the manual gave us.
 *
 * The FIELD is the safe part: every FTC field since 2007 has been a 12 ft × 12 ft (144") soft
 * tile field inside a perimeter wall, and R102/R104 are unchanged from DECODE. Origin at the
 * centre, +x = audience right, +y = away from the audience — the same frame DECODE and Chain
 * Reaction use, so the shared camera, drivetrain and Rapier solve need no per-game handling.
 *
 * ── TERMINOLOGY (see `docs/biobuzz-contract.md` §6) ─────────────────────────
 * The scoring element is a POLLEN. Not a ball, not a particle, not an artifact — those are
 * DECODE's and Chain Reaction's words, and the user-visible strings in this game say POLLEN.
 * Pollen ride `world.balls` as `Artifact`s because that is the shared transport the physics,
 * the snapshot and the wire already speak; the TYPE is shared, the NAME is not.
 *
 * Copied and owned from `games/chain/config.ts`. Everything catalyst / hook / accelerator /
 * ring-stand / beam / lab-area / ground-clearance specific is deleted rather than carried
 * over — a shell that ships CR's field furniture under BIOBUZZ names would be worse than an
 * empty field, because it would look finished.
 */

import type { Alliance, AssistConfig, DrivetrainType, RobotSpec, StartCat, Vec2, World } from '../../types';
import { DRIVETRAIN_LIMITS, INTAKE_PRESETS, ROBOT_MAX_SIZE } from '../../config';
import { clamp, datan2, dcos, dsin, hyp, wrapAngle } from '../../math';
import { lengthLimits, widthLimits } from '../../sim/drivetrain';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbMountPos,
  type BbScoreMode,
  EDGE_ANGLE,
  MOUNT_DIR,
  bbIntakeMountOf,
  bbShooterEdgeOf,
  edgeGeom,
  mountOrigin,
  turretLocal,
} from './mounts';
// `mechs.ts` is a LEAF over `types` + `mounts`, so this import adds no cycle — the same reason
// `mounts.ts` itself is safe to import here.
import { type BbIntakeKind, bbLauncherOf, bbLiftOf, bbResolveMount2 } from './mechs';
// THE FIELD'S DIMENSIONS ARE GENERATED FROM THE CAD, NOT TYPED HERE (owner ruling, 2026-09-18:
// "the CAD is authoritative for dimensions"). `fieldDims.gen.ts` is written by `npm run
// field-cad` out of `public/models/biobuzz/field-measurements.json`, and its header states the
// derivation and the residual of every value. Nothing in it is hand-editable, and the SIM3D
// smoke lane re-renders it and diffs it so it cannot drift from the measurements.
//
// The CONSTANT NAMES below are unchanged — every caller still imports `BB_HALF_X`, `BB_FLOWERS`
// and the rest — and each one's comment now cites the CAD and keeps the manual figure it
// replaced, because the figure is the history of why the number used to be what it was.
import {
  FIELD_HALF,
  FLOWERS,
  FLOWER_D,
  FLOWER_FOOT,
  FLOWER_RETRIEVAL_Z,
  FLOWER_RING_D,
  FLOWER_RING_Z,
  GARDEN,
  HIVE,
  LZ,
  TAPE,
  TAPE_W,
  TILE_PITCH,
  TILE_SEAMS,
} from './fieldDims.gen';

/** millimetres → inches (the sim's world unit). The manual dimensions arrive in mm, so this
 * is the conversion every element constant is written THROUGH rather than pre-multiplied,
 * which keeps the manual's own number visible in the source. */
export const mm = (v: number): number => v / 25.4;

// ─────────────────────────────────────────────────────────────────────────────
// FIELD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * field half-extents (in) — the perimeter wall's INNER FACE, measured off FIRST's own field CAD.
 *
 * ⚠️ **NOT 72.** A "12 ft field" is the nominal description, not the dimension: the CAD's four
 * inner faces sit at ±70.674 (residual 0.000 — they are symmetric), so the clear span is 141.35
 * in, not 144. It follows from the tiles, which are `BB_TILE_PITCH` 23.528 in on centre and not
 * 24; six of them close on 141.17 and the perimeter closes on that plus its own clearance. The
 * manual never prints an interior span, so there is nothing here the CAD contradicts — the 144
 * was inherited from DECODE's `C.TILE`-based field and was wrong by 1.87 %.
 *
 * Owner ruling, 2026-09-18: "The CAD is authoritative for dimensions." See `fieldDims.gen.ts`.
 */
export const BB_HALF_X = FIELD_HALF;
export const BB_HALF_Y = FIELD_HALF;

/**
 * soft-tile pitch on centre (in) — CAD (`fieldDims.gen.ts`), and the reason the field is not 144
 * wide. BIOBUZZ draws its own grid from this and from `BB_TILE_SEAMS`; `C.TILE` (24) stays
 * DECODE's and Chain Reaction's, because their fields are still modelled on the nominal tile.
 *
 * The seams are NOT evenly spaced — a tile body is 24.312 in with its interlock tabs, and the
 * measured gaps run 23.176…23.986 — so anything DRAWING the grid uses `BB_TILE_SEAMS`, the seven
 * measured lines, and this constant is their mean, for the places that need one number.
 */
export const BB_TILE_PITCH = TILE_PITCH;
export const BB_TILE_SEAMS = TILE_SEAMS;

/** perimeter wall collider half-thickness (in). Deliberately far thicker than a real wall:
 * these cuboids sit entirely OUTSIDE the play area, and a thick static is what stops a fast
 * robot from tunnelling through a thin one in a single 1/60 s step. */
export const BB_WALL_T = 10;

/** camera fit margin (in) — breathing room around the field so the walls are not flush with
 * the viewport edge.
 *
 * WIDENED from 8 for the FLOWER SECTION: a flower's contents are drawn OUTSIDE the perimeter
 * beside it (`drawField.ts`), as a section of the column with the scoring band shaded. It
 * reaches 10.8 in out, and the tile ruler lives in the same band, so the margin has to clear
 * both or the readout is cropped by the viewport on the two walls that carry them.
 *
 * IT IS A FIXED COST, not a per-element one — the section is as wide for an empty FLOWER as
 * for a full one, because the drawing is the COLUMN and the elements are inside it. The row of
 * discs it replaced grew with the stack, which made this number a function of capacity and
 * therefore wrong every time the capacity moved. `bbFlowerSectionBox` measures the real extent
 * and the smoke lane checks it against this. */
export const BB_VIEW_MARGIN = 12;

/** the outer x half-extent the CAMERA must show. Equal to the wall: V1's ARENA (Section 9) puts
 * the HIVES, FLOWERS and zones all inside the perimeter, so BIOBUZZ has no structure protruding
 * outside it (CR's accelerators did, which is why the shared `bounds` carries a view extent
 * distinct from the collider extent at all). The FLOWER sections drawn beside the walls are a
 * READOUT, and `BB_VIEW_MARGIN` above is what clears them. */
export const BB_VIEW_HALF_X = BB_HALF_X;

// ─────────────────────────────────────────────────────────────────────────────
// ---- FIELD GEOMETRY (manual V1)
//
// Everything below comes off the Kickoff Competition Manual V1 (2026-09-12), distilled in
// `docs/biobuzz-reference.md` §2 with the figure number for each value. A constant whose
// value the manual PRINTS carries the section or figure it came from; a constant DERIVED
// from a drawing carries `// APPROX: <figure>` in exactly the words the reference tags it
// with, because `grep APPROX src/games/biobuzz/config.ts` is the 09-14 tape-measure list.
//
// THE LAYOUT IS POINT-SYMMETRIC (180° about the origin), NOT MIRRORED. Red's LOADING ZONE is
// at y > 0 on the left wall and its GARDEN is the audience-left corner; blue's are the
// diagonal opposites. See `bbMirror` under START ANCHORS. Reflecting this field in x instead
// of rotating it produces a layout that is internally consistent and wrong.
// ─────────────────────────────────────────────────────────────────────────────

/** an axis-aligned field region, in world inches. `x0 < x1` and `y0 < y1` always. */
export interface BbRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * LOADING ZONE — 11.57 wide × 22.69 deep against the side wall, bounded by tape and the wall,
 * tape included (§9.3, Fig 9-2 p65 / Fig 9-3 p66). The zone belongs to the alliance whose
 * ALLIANCE AREA it adjoins.
 *
 * CAD (`fieldDims.gen.ts`), no longer `APPROX`: the CAD carries the three real gaffer strips, so
 * the rectangle is the union of their outer faces with the WALL edge as the fourth side — the
 * wall-bounded edge carries no tape, which is why there are three strips and not four. The old
 * figure read (x −72…−61, y 24…48) is off by 1.33 at the wall, 1.90 at the inner edge and up to
 * 1.40 in y; all of it is the field-size finding, not a misread of the drawing.
 *
 * RED IS AT y > 0. That is the half of the field an x-mirror gets wrong.
 */
export const BB_LZ: Record<Alliance, BbRect> = { red: LZ.red, blue: LZ.blue };

/**
 * WHERE AN ELEMENT ENTERS THE FIELD FROM A HUMAN PLAYER'S HAND — the centre of `a`'s LOADING
 * ZONE, pulled `r` off the side wall the zone backs onto.
 *
 * ONE definition, because three callers need the same point and they must not drift: staging
 * puts a no-show robot's preloads there (§10.3.4), the human player enters NECTAR there all
 * match (G426/G427, `play.ts`), and the smoke lane asserts both. `r` is the entering element's
 * RADIUS: "contacting the wall" is a body touching it, which for a circle solved at its centre
 * means a centre one radius clear — put the centre ON the wall line and the solve's first job
 * is to eject it.
 */
export function bbLoadingZoneSpot(a: Alliance, r: number = BB_POLLEN_R): Vec2 {
  const z = BB_LZ[a];
  return { x: a === 'red' ? -BB_HALF_X + r : BB_HALF_X - r, y: (z.y0 + z.y1) / 2 };
}

/**
 * GARDEN — a ~23 × 2 in strip in the alliance's own corner, "defined by the outside edge of
 * tape", two 1-in tapes (§9.3, §10.5.3, Fig 9-2/9-3). Red's runs along the AUDIENCE wall from
 * the red corner; blue's along the REAR wall from the blue corner. Not protected (G411 note).
 */
export const BB_GARDEN: Record<Alliance, BbRect> = { red: GARDEN.red, blue: GARDEN.blue };

/**
 * THE TAPE STRIPS THEMSELVES — what a renderer draws, as opposed to the zone rectangles above.
 *
 * CAD (`fieldDims.gen.ts`): 16 parts, every one 1.000 in wide, and the layout is the rule the
 * owner stated and the CAD confirms part for part — **a zone edge that is a WALL carries no
 * tape**. A LOADING ZONE has three strips (two depth edges and the inner, field-side edge); a
 * GARDEN has two laid side by side, which IS the 2-in band, with nothing across its ends; the
 * ALLIANCE AREA has three, on the gym floor outside the perimeter, open on the field side.
 *
 * Outlining `BB_LZ`/`BB_GARDEN` instead — which both renderers used to do — paints tape onto the
 * wall and turns the garden's solid band into two thin lines with mat between them.
 */
export const BB_TAPE = TAPE;

/**
 * THE ONE TAPE WIDTH ON THIS FIELD (in) — CAD, via `fieldDims.gen.ts`: all 16 strips measure
 * 1.000, and `field-measurements.json` carries `tape.widthsIn` as a one-element list.
 *
 * The Event Field Guide V1.0 §8.1 (p13) allows the field to be taped with **either** 1 in or 2 in
 * ProGaff, "the outside perimeter of each zone should be consistent with the specifications, but
 * the tape width may vary" — §8.3's figure draws the LOADING ZONE both ways and §8.4's draws the
 * GARDEN as [2] 1-in pieces OR [1] 2-in piece. A renderer has to pick one build, and the build the
 * CAD ships is 1 in, so that is the one the sim draws.
 *
 * ⚠️ NOT `C.TAPE_W`. The shared constant of the same value is DECODE's field, arrived at
 * independently; both renderers used to reach for it and a BIOBUZZ tape width therefore had two
 * homes. There is one, it is this, and it is the CAD's.
 *
 * ⚠️ AND IT IS NOT A LINE WIDTH. Every tape mark is a FILLED rectangle out of `BB_TAPE`, which
 * already carries the measured width; this constant is the CONTRACT those rectangles are checked
 * against (the field lane proves every strip is exactly this wide, and the garden band exactly
 * two of them), not a number a renderer multiplies by. `BB_TAPE_2` is gone for the same reason.
 */
export const BB_TAPE_W = TAPE_W;

// ── HIVE STRUCTURE (§9.6, Figs 9-7…9-11, pp69–73) ────────────────────────────

/** pivot x of each HIVE (in): the pair is 25.5 in centre to centre (Fig 9-10), red at −x.
 * CAD (`fieldDims.gen.ts`) — the measured pivots are ±12.750 with a 0.000 residual, which
 * CONFIRMS Fig 9-10's spacing and the `APPROX` assumption that the pair is centred on the
 * field. No longer approximate. */
export const BB_HIVE_X = HIVE.PIVOT_X;

/**
 * the BAR's tilt off level at either stable end (degrees) — the ±30° of a bi-stable see-saw
 * (§9.6, Figs 9-7…9-11; `docs/biobuzz-reference.md` §2.2). CAD-CONFIRMED to 0.000°: un-tilting
 * the tray by exactly this angle collapses the 0.020-in back skin to its own thickness, and by
 * any other angle spreads it over inches (audit §4.1). That is the one measurement that proves
 * the whole tray export is in the frame it claims to be.
 *
 * It is already baked into every PLAN length below as a cos 30° — `BB_HIVE_CELL_DY`,
 * `BB_HIVE_CELL_LEN` and `BB_HIVE_LEN` are the projected numbers, not the true ones. The
 * constant exists so the SWING can be drawn: mid-tip the bar passes LEVEL, where the
 * foreshortening is 1 and the assembly reaches its true length, and a renderer animating that
 * needs the angle the projection came from rather than a second copy of 30 typed into it.
 */
export const BB_HIVE_TILT_DEG = HIVE.TILT_DEG;

/** the plan projection at the rest tilt — every PLAN length below is a true CAD length times
 * this. Written once so the three of them cannot drift apart.
 *
 * `dcos`, not `Math.cos`: this value is baked into staged element positions and into the hive
 * footprint the scorer reads, so it is sim state, and `scripts/smoke.ts`'s source guard bans
 * engine-defined trig anywhere under `src/games` for exactly that reason. */
const HIVE_PROJ = dcos((HIVE.TILT_DEG * Math.PI) / 180);

/** horizontal projection (in) of a CELL centre from its pivot, along the HIVE axis (y) —
 * `HIVE.ARM` (15.519) · cos 30°. CAD (`fieldDims.gen.ts`); the earlier owner-CAD read was
 * 15.44 · cos 30° = 13.37, 0.07 in short. */
export const BB_HIVE_CELL_DY = HIVE.ARM * HIVE_PROJ;

/** a CELL's depth along the HIVE axis IN PLAN (in) — `HIVE.CELL_D` (11.750) projected. CAD; the
 * earlier read was 12.04 true → 10.43 in plan, 0.25 in long. */
export const BB_HIVE_CELL_LEN = HIVE.CELL_D * HIVE_PROJ;

/** the up-CELL opening's bottom and top above the tiles (in). This is the window a LAUNCH has to
 * arrive through, and what `releasePollen` solves its arc against.
 *
 * CAD (`fieldDims.gen.ts`), measured at the mouth face of whichever cell is UP at rest. Fig 9-10
 * prints [53.5, 65.6] and the CAD says [53.375, 65.497] — agreement to 0.13 in, so this one is a
 * CONFIRMATION of the figure rather than a correction of it. (The "[47.05, 68.85]" once logged as
 * an open finding was a collider-export bug, audit §4.4, and is long closed.) */
export const BB_HIVE_OPEN_Z: readonly [number, number] = HIVE.OPEN_Z;

/**
 * bottom of the DOWN hive above the tiles (in). The space under the structure is drivable, which
 * G409 assumes; the 2D sim simply puts no collider there.
 *
 * ⚠️ **CAD 31.981, NOT Fig 9-10's 25.5** — the one place the CAD and the manual genuinely
 * disagree, and the owner ruled on 2026-09-18 that the CAD wins. It is not a measurement error on
 * either side: ONE RIGID BAR at 30° cannot put the up cell's mouth at 53.4 and the down cell's
 * floor at 25.5 at the same time on this tray's own dimensions, and the CAD's up-cell opening
 * matches the manual to 0.13 in, so the figure that has to give is this one. The lowest hive
 * structure of ANY kind at rest is the Goal Rib's lower corner at 30.652, so a 29-in robot — the
 * legal maximum — still clears the whole assembly, which is what G409 actually needs.
 */
export const BB_HIVE_BOTTOM_Z = HIVE.DOWN_FLOOR_Z;

/** the lowest point of the hive assembly at rest (in) — CAD, the down-mouth Goal Rib's own lower
 * corner, which is below the down CELL's floor. The real headroom under a hive, and the number
 * that says a legal 29-in robot drives under it. */
export const BB_HIVE_LOWEST_Z = HIVE.LOWEST_Z;

/** the up-CELL's ACCEPT FOOTPRINT (in): `w` across the HIVE, `d` along it.
 *
 * MEASURED (reference §2.2). The 20-in opening WIDTH is perpendicular to the tilt axis, so it
 * is NOT foreshortened; the DEPTH is, and is `BB_HIVE_CELL_LEN` — the same 10.43 the cell is
 * drawn at, because the launch window and the cell footprint are the same rectangle. */
export const BB_CELL_OPEN = { w: HIVE.CELL_W, d: BB_HIVE_CELL_LEN };

/**
 * the CELL assembly end to end IN PLAN, along y (in) — 42.91 true · cos 30°. MEASURED
 * (reference §2.2).
 *
 * BOTH ENDS FORESHORTEN. The two CELLS ride ONE RIGID BAR at 30°, so a top-down view projects
 * the whole assembly by the same cosine and only `z` separates the up cell from the down one.
 * Drawing the up cell at full length and the down cell short says the bar bends, and it makes
 * the hive 42.91 long in a view where nothing on it is.
 */
export const BB_HIVE_LEN = HIVE.LEN * HIVE_PROJ;

/** the CELL assembly across, along x (in) — the opening width, which is PERPENDICULAR to the
 * tilt axis and so is not foreshortened. CAD 20.141 (`HIVE.CELL_W`, the mean of the four measured
 * cells); the manual's round 20 was within 0.15. */
export const BB_HIVE_W = HIVE.CELL_W;

/**
 * frame BASE BAR, inner and outer x (in) — MEASURED (owner CAD, 2026-09-12; reference §2.2):
 * bent sheet metal, effective 1 in thick, with its INNER edge ON the ±24 tile seam and the
 * other edge 1 in OUTWARD. So a bar occupies x ∈ [24, 25] and x ∈ [−25, −24].
 *
 * Two edges rather than a centre and a thickness because the edge on the seam is the measured
 * fact: a centre-plus-width pair rounds the seam away, and the seam is what a driver lines up
 * against. The COLLIDER is `colliders.ts` (biobuzz-field-staging); these are the numbers it
 * and the drawing share.
 */
export const BB_FRAME_BAR_IN = 24;
export const BB_FRAME_BAR_OUT = 25;

/** frame foot half-extent along y (in) — MEASURED 19.4 (reference §2.2; Fig 9-8 prints a
 * 38.95-in frame depth and the CAD measures 38.80). */
export const BB_FRAME_Y = 19.4;

/**
 * APRILTAG ID GROUPS — four 36h11 tags on the bottom face of every CELL (§9.9, Figs 9-15…9-17,
 * pp74–77). Keyed by the CELL's side of the pivot: `north` is y > 0 (the REAR, opposite the
 * audience), `south` is y < 0 (the AUDIENCE side).
 *
 * Drawn on the field on purpose. A published tag id is the ONE thing that pins this layout to
 * the real one, so a still that prints them can be checked against the manual without opening
 * it — the mirror test in `docs/biobuzz-reference.md` §9.
 */
export const BB_HIVE_TAGS: Record<Alliance, { north: readonly number[]; south: readonly number[] }> = {
  red: { north: [30, 31, 32, 33], south: [34, 35, 36, 37] },
  blue: { north: [42, 43, 44, 45], south: [38, 39, 40, 41] },
};

/** which CELL faces UP at staging (§10.3.1, Fig 10-2 p83): each HIVE is tilted so the cell
 * that points at a FLOWER is DOWN, which puts red's south cell and blue's north cell up. */
export const BB_HIVE_UP_STAGED: Record<Alliance, 'north' | 'south'> = { red: 'south', blue: 'north' };

// ── FLOWERS (§9.7, Fig 9-12, pp72–73) ────────────────────────────────────────

/** stand-off of a FLOWER's ring centre from its WALL FACE (in). CAD (`fieldDims.gen.ts`):
 * `FIELD_HALF` minus the least-squares centre of the top ring's own bore, 2.629, over four
 * flowers with a 0.000 residual. The earlier owner-CAD read of 2.54 was within 0.09 — this
 * figure was never the problem; the WALL it is measured from was 1.33 in out. */
export const BB_FLOWER_D = FLOWER_D;

/**
 * The four FLOWERS, one per perimeter wall, on the tile seam one tile off centre.
 *
 * CAD (`fieldDims.gen.ts`): each position is the least-squares centre of that flower's own TOP
 * RING BORE — the hole an element is deposited through — re-expressed point-symmetrically as
 * `BB_FLOWER_D` off its wall face and `FLOWER_ALONG` (23.392) along it. `nearest` is the
 * alliance whose half of the wall it sits on, NOT ownership: a FLOWER is owned at run time by
 * whoever holds the top-most NECTAR (§10.5.2).
 *
 * THE ±24 WAS THE TILE SEAM, AND THE TILE SEAM MOVED. The earlier table put each flower on the
 * ±24.000 seam of a nominal 24-in tile. Real tiles are `BB_TILE_PITCH` 23.528 on centre, so that
 * seam is really at 23.392 — one tile's worth of accumulated pitch error — and the wall it is
 * measured from is at 70.674, not 72. Both deltas are the SAME finding, and together they are
 * the ~1.5 in the CAD audit reported for these four points.
 */
export const BB_FLOWERS: readonly {
  id: string;
  wall: 'left' | 'rear' | 'right' | 'audience';
  x: number;
  y: number;
  nearest: Alliance;
}[] = FLOWERS;

/**
 * WHICH WAY A FLOWER'S MOUTH FACES — out of the wall it stands against, into the field.
 *
 * The FLOWER is a column on the perimeter, so its open top is reachable from one half-space
 * only: the field side. The wall side is the wall.
 *
 * IT LIVES IN `config.ts`, BESIDE `BB_FLOWERS`, because it is a property of that table: given
 * a wall, the inward normal is fixed geometry and nothing about it is a rule or a drawing. It
 * sat in `elements.ts` while its only readers were that file and `drawField.ts`; `start.ts`
 * became a third (G304.D measures the keep-out along this normal) and `elements.ts` in turn
 * needs `start.ts` for `evalStart`, which would have closed a two-file import cycle for the
 * sake of a four-entry map. Moving the map breaks the cycle without duplicating anything.
 */
export const FLOWER_MOUTH: Record<(typeof BB_FLOWERS)[number]['wall'], Vec2> = {
  left: { x: 1, y: 0 }, // F1 stands on −x, opens toward +x
  rear: { x: 0, y: -1 }, // F2 stands on +y, opens toward −y
  right: { x: -1, y: 0 }, // F3 stands on +x, opens toward −x
  audience: { x: 0, y: 1 }, // F4 stands on −y, opens toward +y
};

/**
 * ── THE FLOWER TUBE, BOTTOM TO TOP — five CAD bands, no APPROX left ─────────────────────────
 *
 *   `BB_FLOWER_LOW_Z`   0.354   the LOWER plate's top face: the column's floor
 *   the RETRIEVAL OPENING          0.354 → 3.904, 3.550 in of clear gap on the field side
 *   `BB_FLOWER_MID_Z`   3.904   the MID plate's underside: where the scoring volume starts
 *   the SCORING VOLUME             3.904 → 21.404 (§10.5.2, "between the top and middle rings")
 *   `BB_FLOWER_TOP_Z`  21.404   the TOP plate's top face: the z a deposit arc solves for
 *
 * All four were hand-typed manual or APPROX figures until 2026-09-18 (Day 2 lane A):
 * `field-measurements.json` carried the flower's whole assembly extent (−0.649 … 22.654, which
 * tops out at the purple backstop) but never separated the three ring PLATES, so there was
 * nothing in the generated file to read. `convert.py` measures each plate's own band now.
 *
 * ⚠️ **THE 3.550-IN RETRIEVAL OPENING IS DERIVED, NOT MEASURED, AND IT LANDS ON FIG 9-12
 * EXACTLY.** Nothing in the STEP is the hole; it is `mid[0] − lower[1]`, and the manual prints
 * "3.55 in tall". Two independently measured plate bands reproducing a printed figure to three
 * decimals is the strongest evidence in this file that the flower export is in the right frame.
 */

/** top ring height above the tiles (in) — the TOP plate's own top face, CAD
 * (`fieldDims.gen.ts`, `FLOWER_RING_Z.top`, residual 0 over four flowers). Fig 9-12's 21.5 was
 * 0.096 high; the audit's §6 hand read of 20.254…21.404 is now the generated number. */
export const BB_FLOWER_TOP_Z = FLOWER_RING_Z.top[1];

/**
 * the MIDDLE plate's UNDERSIDE (in) — where the SCORING VOLUME starts, and, in the 2D pipeline's
 * stack model, where a NECTAR seats. CAD (`FLOWER_RING_Z.mid[0]`, residual 0).
 *
 * It was 3.98 `APPROX` in `flower.ts` (the retrieval opening 3.55 plus a 0.43 lower ring), and
 * the CAD says 3.904 — the same quantity, 0.076 lower, with the same meaning, so every outcome
 * the sorter ruling produces survives the move (checked: the capacities are still 8 POLLEN and
 * 5 NECTAR, and every Fig 10-5 case A–H reads the same).
 *
 * ⚠️ **THE CAD'S MIDDLE BORE DOES NOT SORT.** `BB_FLOWER_MID_HOLE` measures 3.896 and a NECTAR
 * is 3.6, so the real plate passes one — which the 2D pipeline's own sorter ruling (owner,
 * 2026-09-12: "a NECTAR cannot pass the middle ring and SEATS on it") says it does not. The
 * ruling is a GAMEPLAY decision and it stands for the 2D model. The 3D tube used the geometry
 * as measured, so a NECTAR fell to the tiles and a ramp could drag it out; since 2026-09-24 it
 * adds the lip the real ring must have (`BB3_FLOWER_NECTAR_SORT_D`), and both pipelines seat a
 * NECTAR here. `docs/biobuzz/field-cad-audit.md` §11 has the measurement.
 */
export const BB_FLOWER_MID_Z = FLOWER_RING_Z.mid[0];

/** the LOWER plate's TOP FACE (in) — the column's floor in the 2D stack model. CAD
 * (`FLOWER_RING_Z.lower[1]`); it was 0.43 `APPROX`, a Fig 9-12 pixel read, 0.076 high. */
export const BB_FLOWER_LOW_Z = FLOWER_RING_Z.lower[1];

/** the RETRIEVAL OPENING's own z span (in) — the clear gap between the lower plate's top face
 * and the mid plate's underside, on the FIELD side (the wall side is the backstop extrusion).
 * 3.550 in tall, which is Fig 9-12's printed figure to three decimals. G418.B's bottom-pop and
 * the 3D intake sensor both read this band. */
export const BB_FLOWER_RETRIEVE_Z: readonly [number, number] = FLOWER_RETRIEVAL_Z;

/**
 * the MIDDLE and LOWER bore DIAMETERS (in) — CAD least-squares fits (`FLOWER_RING_D`), residual
 * 0 over four flowers, rms 0.052 / 0.038 on the fit itself.
 *
 * ⚠️ **THE SORTER IS THE LOWER RING, NOT THE MIDDLE ONE.** A 2.8-in POLLEN passes all three
 * bores; a 3.6-in NECTAR passes the top (4.171) and the middle (3.896) and is stopped by the
 * lower (3.222). So the manual's INTENT survives — "POLLEN out of the bottom and nothing else"
 * (G418), because a nectar clears neither the lower bore nor the 3.55-in retrieval opening — but
 * the ring that delivers it is the bottom one, and by these numbers alone a nectar falls to the
 * bottom of the tube. That put it on the tiles in the retrieval opening, where a ramp could drag
 * it out, so the 3D middle ring carries a NECTAR-only lip (`BB3_FLOWER_NECTAR_SORT_D`, owner
 * 2026-09-24) and seats it there, as G418 and the 2D model both have it. See `BB_FLOWER_MID_Z`.
 */
export const BB_FLOWER_MID_HOLE = FLOWER_RING_D.mid;
export const BB_FLOWER_LOW_HOLE = FLOWER_RING_D.lower;

/** the three PLATE bands themselves, re-exported so `sim3d/flowerTube.ts` and the FLOWER3D lane
 * read the geometry through `config.ts` like every other BIOBUZZ constant rather than reaching
 * into the generated module. The five named `BB_FLOWER_*_Z` constants above are the faces the
 * RULES care about; this is the raw pair per plate, which is what a COLLIDER needs. */
export { FLOWER_RING_Z };

/** top ring opening RADIUS (in) — CAD (`fieldDims.gen.ts`, `FLOWER_RING_D.top` 4.171 measured by
 * a least-squares circle fit to the plate's own inner cylindrical surface, rms 0.049). Fig 9-12's
 * round 4.0 was 0.17 under. A 2.8 POLLEN and a 3.6 NECTAR both pass it; only the POLLEN passes
 * the retrieval opening at the bottom (`FLOWER_RING_D.lower` 3.222, G418). */
export const BB_FLOWER_OPEN_R = FLOWER_RING_D.top / 2;

/**
 * ⚠️ **THE FLOWER IS MUCH WIDER THAN ITS BORE, AND THE BOX TUBE HAS TO CLEAR THE SOLID, NOT THE
 * HOLE** (owner, 2026-09-22: "the offset boxtube still meshes with the flower"). The first pass
 * aimed the arm at the top ring's OPENING radius — 2.086 — which is the hole an element drops
 * through and not the part a tube hits. The ring PLATE around it, its hardware and the column's
 * supports all stand further out, so an arm that stopped on the bore rim still cut the plate.
 *
 * `BB_FLOWER_OUTER_R` is the flower's own OUTER radius about its top-bore centre, sampled every
 * 5° from the wall normal (index 0 = straight out of the wall, index 18 = along the wall), over
 * the FIELD half only — the half a robot can be in. MEASURED off the shipped `field.glb`
 * (`flower_0`, all six meshes, every vertex with z ≤ `BB_FLOWER_TOP_Z`) and DILATED by ±15° at
 * each sample, so a thick arm that spans a few degrees of azimuth cannot slip into the notch
 * between two samples. **The RENDER lane re-measures it off the asset and pins this table**, so a
 * new field export that grows the flower fails there rather than quietly re-introducing the bug.
 *
 * What the numbers say: 2.392 straight out of the wall, rising to 3.113 at 35°–60° (the plate
 * corners), 2.972 along the wall. The bore is 2.086 — the solid is **0.31 to 1.03 in wider than
 * the hole**, which is the whole of the report.
 *
 * ⚠️ AND THE COLUMN IS EMPTY ON THE FIELD SIDE BETWEEN THE PLATES. Measured in the same pass:
 * z 0.4…3.9 (the retrieval opening) and z 5.3…20.2 have **no flower geometry at all** in the
 * field half — the four HIPS support pipes are on the WALL side, at azimuth 135°–215°. So a tube
 * rising on the field side only ever has to clear the MID plate (z 3.9…5.3, and the shoulder
 * already sits above it at `BB_BOX_TUBE_Z` 5.55) and the TOP plate. That is why the arm can go
 * nearly vertical instead of standing a foot off.
 */
export const BB_FLOWER_OUTER_R: readonly number[] = [
  2.392, 2.392, 2.502, 2.738, 2.928, 3.05, 3.105, 3.113, 3.113, 3.113, 3.113, 3.113, 3.113, 3.049,
  2.963, 2.972, 2.972, 2.972, 2.972,
];
export const BB_FLOWER_OUTER_MIN = 2.392;
export const BB_FLOWER_OUTER_MAX = 3.113;

/**
 * The flower's outer radius in the direction a mechanism approaches from — `theta` is the angle
 * between the flower's INWARD wall normal (`FLOWER_MOUTH`) and the horizontal line from its bore
 * centre to that mechanism, in radians, either sign.
 *
 * It reads the table with NO interpolation and takes the LARGER of the two samples it falls
 * between: a sample is a ±15° dilated maximum, so the larger neighbour is the conservative answer
 * and a lerp between them would dip below the solid between samples.
 */
export function bbFlowerOuterR(theta: number): number {
  const t = Math.abs(theta) * (180 / Math.PI);
  if (!(t >= 0)) return BB_FLOWER_OUTER_MAX; // NaN
  if (t >= 90) return BB_FLOWER_OUTER_R[BB_FLOWER_OUTER_R.length - 1];
  const k = t / 5;
  const lo = Math.floor(k);
  const hi = Math.min(BB_FLOWER_OUTER_R.length - 1, lo + 1);
  return Math.max(BB_FLOWER_OUTER_R[lo], BB_FLOWER_OUTER_R[hi]);
}

/**
 * the FLOWER's FOOTPRINT on the tiles (in) — `along` the wall by `deep` into the field, flush
 * against the wall face. MEASURED (owner CAD, 2026-09-12; reference §2.3).
 *
 * A RECTANGLE, NOT A DISC. The first pass read Fig 9-12's ring plate as an `APPROX` 2.6-in
 * circle; the solid a robot actually meets is a 6 × 4.9 box with the ring opening inside it,
 * BB_FLOWER_D off the wall. The difference matters at both ends — it is wider along the wall
 * than a 2.6 disc (a robot running the wall hits it sooner) and shallower into the field (it
 * protrudes 4.9, not 5.2, and its corners are square).
 *
 * ✅ GENERATED SINCE 2026-09-18 (Day 2 lane A): `FLOWER_FOOT` is the union of the three ring
 * PLATES' own footprints, 5.951 × 5.013, residual 0 over four flowers. It could not be read off
 * `flowers[].extent` — that carries the under-field bracket reaching BEHIND the wall plane and
 * the backstop above the top plate — which is why the hand-typed 6 × 4.9 survived this long. It
 * was within 0.05 along and 0.11 deep, so this is a confirmation with a small correction, not a
 * move.
 *
 * The COLLIDER is `colliders.ts` (biobuzz-field-staging); this is the number it and the
 * drawing share.
 */
export const BB_FLOWER_FOOT = FLOWER_FOOT;

/**
 * THE HIVE TIP TABLE. Indexed by the number of NECTAR in the up-CELL; the value is how many
 * POLLEN also have to be in it for the CELL to tip. A cell tips when
 * `pollen >= BB_TIP_POLLEN[Math.min(nectar, 5)]`.
 *
 * ── TWO ROWS ARE OFFICIAL — the 2026-2027 EVENT FIELD SETUP GUIDE, §12 Hive Calibration ──
 * The Competition Manual prints no load, but the field guide requires every HIVE to be
 * CALIBRATED (with ballast washers) to tip at "[8] Pollen + [0] Nectar" and "[3] Pollen + [3]
 * Nectar" (§12, V1.0 p26), and its §12.3 acceptance table makes both rows exact:
 *   · 0 NECTAR — with 6 in, a TOSSED-IN 7th must NOT tip; with 7 in, a tossed-in 8th MUST tip;
 *   · 3 NECTAR — with 1 in, a tossed-in 2nd must NOT tip; with 2 in, a tossed-in 3rd MUST tip.
 * ("Gently placed" is only "preferred" to tip.) A launched element is the tossed-in case, so
 * rows 0 and 3 below are the guide's thresholds exactly.
 *
 * Rows 1, 2, 4 and 5 are NOT in the guide: MEASURED on a real HIVE (owner, 2026-09-12), once.
 *
 * **IT IS A TABLE, NOT A MASS, AND NOTHING INTERPOLATES IT.** No single linear weighting fits
 * the measured rows: 1n+7p and 2n+6p together make a NECTAR worth one POLLEN, and 3n+3p then
 * contradicts that outright. A seesaw is torque and packing, not weight. The rows are monotone
 * (more of either element still tips), so the comparison above is the whole rule.
 *
 * The STAGED row is the one that decides how a match opens: a CELL is staged with 3 NECTAR
 * (§10.3.1), so the first TIP costs **3 POLLEN** and is reachable in AUTO.
 *
 * Index 0 used to be an `APPROX` extrapolation of the 7/6 trend; the field guide confirms 8
 * (2026-09-13), so no row is a guess any more. `docs/biobuzz/feedback/002-thresholds.md` §2
 * still asks for a second reading of the owner-measured rows; the smoke lane pins this array as
 * a literal so a re-measure has to come through it.
 *
 * See `docs/biobuzz-reference.md` §4.1.
 */
export const BB_TIP_POLLEN: readonly number[] = [8, 7, 6, 3, 1, 0];

/** seconds of TELEOP remaining at which NECTAR may legally enter a FLOWER (G410). Before this
 * cue it is a MAJOR per nectar to the opponent — and the element still scores (§10.5.2). */
export const BB_FLOWER_UNLOCK_S = 60;

// ── SCORING (§10.5, Table 10-2 p91; fouls Table 10-4 p92) ────────────────────

/**
 * The points table, verbatim from Table 10-2. Everything the sim awards reads a member of this
 * object rather than a literal, so a V2 revision to the table is one edit here.
 *
 * MAJOR IS 20, not DECODE's 15. A shared `awardFoul` that assumes 15 bills this game wrong —
 * see `docs/biobuzz/field-plan.md` §6 request 4.
 */
export const BB_PTS = {
  /** no longer contacting the perimeter wall at the end of AUTO */
  leave: 3,
  /** at least partially in a LOADING ZONE, assessed at end of AUTO */
  parkAuto: 5,
  /** …and assessed again at the end of the MATCH */
  parkTele: 5,
  /** one HIVE TIP, whenever it completes (AUTO if it completes before TELEOP starts) */
  tip: 20,
  /** each element left in an upward-facing CELL, at rest after the match */
  cell: 2,
  /** bottom-most NECTAR of your colour in a FLOWER, per flower */
  bottomNectar: 5,
  /** each element in a FLOWER you OWN, whoever placed it */
  owned: 2,
  /** each element at least partially in a GARDEN, credited to the GARDEN's colour */
  garden: 1,
  /** Table 10-4 */
  foulMinor: 5,
  foulMajor: 20,
};

/** RANKING POINTS (Tables 10-2/10-3). These thresholds are the "all other events" set;
 * regionals and Championship are TBA in V1. SWARM at 16 is exactly both robots LEAVE and both
 * PARK in AUTO, which is why it is a threshold and not a checklist. */
export const BB_RP = {
  /** LEAVE + PARK points needed for the SWARM RP */
  swarm: 16,
  /** TIPS needed for POLLINATOR 1 */
  pollinator1: 4,
  /** TIPS needed for POLLINATOR 2 */
  pollinator2: 7,
  win: 3,
  tie: 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// POLLEN — the scoring element
// ─────────────────────────────────────────────────────────────────────────────

/** POLLEN radius (in) — 2.8 in diameter, §9.8 (AndyMark am-5851). NOT approximate: the
 * Kickoff manual prints the size, and it retires the 1.5" pre-season guess this constant
 * carried while Section 9 was a placeholder page. */
export const BB_POLLEN_R = 1.4;

/** NECTAR radius (in) — 3.6 in diameter, §9.8 (am-5852). The second element size, and the
 * reason the shared solve grew a per-artifact radius: it is now SIMULATED at this value too,
 * not only drawn at it. Every site reads `b.r ?? radius` (field-plan §6 request 1, LANDED),
 * so a resting NECTAR sits 1.8 in off a wall instead of 1.4 and no longer puts 0.4 in of
 * itself outside the field. ⚠️ `bbRobotSolids` is the one holdout — it still builds every
 * held plug at its `radius` argument, so a CARRIED nectar collides as a POLLEN. */
export const BB_NECTAR_R = 1.8;

/** how many POLLEN are on the field at staging — §10.3.1: 16 in the four FLOWERS, 4 in each
 * GARDEN, 16 preloaded. Manual count, not a placeholder. */
export const BB_POLLEN_COUNT = 40;

/** NECTAR PER ALLIANCE — §9.8: 8 red + 8 blue. Of each alliance's 8, three are staged in its
 * up-CELL and five start in the ALLIANCE AREA as human-player stock (§10.3.1). */
export const BB_NECTAR_COUNT = 8;

/** how many POLLEN the shell scatters. APPROX: 60 is a placeholder chosen to LOOK like a
 * field worth driving on and to be cheap in the shared solve, not a manual count. It is also
 * deliberately far below CR's 300 so the shell's step cost has headroom for whatever Section
 * 10 actually asks for. */
export const BB_POLLEN_SIM = 60;

/**
 * GROUND POLLEN PHYSICS IS NOT CONFIGURED HERE, AND THERE IS NOTHING TO PUT BACK.
 *
 * A ground POLLEN is solved by the SHARED artifact solve (`solveArtifacts`), which BIOBUZZ
 * calls with `BB_POLLEN_R` and nothing else. Friction, restitution, rest speed, contact
 * stiffness and the speed cap are all the shared solve's constants in `src/config.ts`
 * (`PHYS_BALL_*`, `BALL_*`), they are the repo OWNER's to tune, and BIOBUZZ must not shadow
 * them — a second set of numbers describing the same contact is the same bug as a second
 * integrator. See `docs/biobuzz/feedback/000-solver-observations.md` for what the shared solve
 * does with a 1.5" element, and `play.ts`'s header for why it is the only one.
 *
 * Four constants used to live here (`BB_POLLEN_FRICTION`, `_REST_SPEED`, `_SEP_ITERS` and the
 * wall restitution), copied from CR's particle model for the bespoke arm that is now deleted.
 * Only the wall restitution survives, because FLIGHT pollen are still this game's own:
 */

/** how much of its speed a POLLEN keeps when a LOB hits a wall. FLIGHT ONLY — a ground pollen's
 * wall bounce is the shared solve's `BALL_WALL_RESTITUTION`. APPROX: a guess about a 3" foam
 * ball, and only a picture judges it (`launch-wall-bounce` in the gallery). */
export const BB_POLLEN_WALL_REST = 0.35;

// ─────────────────────────────────────────────────────────────────────────────
// MATCH — BIOBUZZ reuses the shared phase durations (`src/config.ts`): V1 §10.1/§10.4 give
// 30 s AUTO, an 8 s transition and 2:00 TELEOP, the same three numbers DECODE runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ACT this season starts on: BIOBUZZ's records and ranked open at Act 1 · Season 1 (owner,
 * 2026-09-12). Acts are per game (`seasons` is keyed on game), so this need not differ from
 * DECODE's or Chain Reaction's. Read through the shared `initialAct` slot (`sim.ts`).
 */
export const BB_INITIAL_ACT = 1;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — intake geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INTAKE DESIGN. The only style in the shell is the SWEEPER — a full-width roller. Its MOUNT
 * (`RobotSpec.intakeMount`) picks which chassis edge(s) carry it: FRONT (default), BACK, both
 * SIDES, or FRONT+BACK.
 *
 * The geometry lives in `bbMouths` (robot.ts) — one rect per mounted edge, shared by the
 * capture logic AND both renderers, so THE DRAWN MOUTHS ARE THE CAPTURE AREAS. The same mount
 * drives `footprintExtents`, so it moves the COLLISION box with it. Open edges cost hopper
 * volume (`bbMountStoreMult`).
 *
 * `widthFrac`·chassis + `overhang` = the mouth half-width on an END edge (a flank mouth spans
 * the chassis length); `depth` = how far behind the edge it reaches, which is what lets the
 * roller catch a POLLEN before the frame would plow it.
 */
export interface BbIntakeGeom {
  widthFrac: number; // mouth half-width as a fraction of the chassis half-width
  overhang: number; // extra mouth half-width past the frame (deployed intake), inches
  depth: number; // mouth reaches this far BEHIND the edge (into the frame), inches
}
export const BB_INTAKE_STYLES = ['sweeper'] as const;
export type BbIntakeStyle = (typeof BB_INTAKE_STYLES)[number];
export const BB_INTAKES: Record<BbIntakeStyle, BbIntakeGeom> = {
  sweeper: { widthFrac: 1.0, overhang: 0, depth: 2.5 }, // full-width roller
};
export const BB_DEFAULT_INTAKE: BbIntakeStyle = 'sweeper';

/**
 * ⚠️ **THE ONE INTAKE REACH** — how far past the frame the roller line sits, in inches.
 *
 * Every BIOBUZZ reader of "how far does the sweeper stick out" goes through this: `bbMouths`
 * (the capture area AND what both renderers draw), `bbFootprint` (the collision extent),
 * `bbRobotSolids` (the side plates a POLLEN meets) and the intake model in `bbIntakeAct`.
 * It is deliberately the SHARED preset's own number — 3.0 / 3.5 / 5.0 in for sloped / vector /
 * triangle, which is the 3–5 in an over-bumper intake really reaches — because
 * `footprintExtents` (`src/sim/field.ts`) grows the hitbox from that same preset, and a BIOBUZZ
 * number here would put the drawn roller and the collider an inch apart.
 *
 * Naming it anyway is the point: four files used to spell `INTAKE_PRESETS[spec.intake].reach`
 * independently, which is exactly how the drawn mouth and the capture zone drift.
 */
export function bbIntakeReach(spec: Pick<RobotSpec, 'intake'>): number {
  return INTAKE_PRESETS[spec.intake].reach;
}

/**
 * THE ROLLER MODEL — what the intake does to a loose element, rather than which rect swallows
 * one. Read only by `bbIntakeAct` (`robot.ts`), which is the single implementation for BOTH
 * physics backends.
 *
 * ⚠️ NONE OF THESE IS A GROUND-POLLEN PHYSICS CONSTANT (`docs/biobuzz-contract.md` §1). They
 * describe HARDWARE — how fast a roller surface moves, how wide its feed throat is, how many
 * elements a minute it can pass — the same class as `BB_INTAKES`' own geometry, and the same
 * class DECODE keeps in `INTAKE_PRESETS.mouth`. Friction, restitution, rest speed and mass
 * still belong to the shared solve, and nothing here touches an element's POSITION: the pull is
 * a VELOCITY contribution written before the solve (2D) or before the next sync (3D), exactly
 * as DECODE's `intakeSuction` is, and the solve is still the only writer of where a POLLEN is.
 *
 * All APPROX — there is no published intake in the manual to measure.
 */
/** roller surface speed (in/s): how fast the rollers walk an element they have hold of toward
 * the throat. Above the ~40 in/s a robot drives at, so a robot driving INTO a pile still draws
 * elements in rather than plowing them; well under a launch speed, so nothing is flung.
 * WAS 52. Raised to 84 (owner: intake cadence "way faster") — ceiling check 1: 84 <
 * `C.BALL_MAX_SPEED` (90) still holds, but the margin shrinks from 38 to 6 in/s (RULES lane
 * asserts this explicitly now, so a future bump that clips in 2D only and diverges the two
 * backends is caught rather than shipped quietly). */
export const BB_INTAKE_DRAW_IN = 84;
/** how much of the draw-in goes into CENTRING an off-centre element, as a fraction of the
 * inboard pull. A full-width sweeper takes an element mostly straight back over the bumper; the
 * compliant wheels' funnel is a secondary effect, not the main one.
 * WAS 0.5. Raised to 0.6 alongside the `BB_INTAKE_DRAW_IN` bump — ceiling check 2:
 * `DRAW_IN * CENTRE_FRAC` = 84*0.6 = 50.4, comfortably under `BB_INTAKE_CROSS_MAX` (80), same
 * margin shape as before (was 52*0.5=26/80). This is the exact self-trip class of bug the
 * funnel's own lateral pull can cause against its own `CROSS_MAX` on the next tick — keep the
 * product well clear of the ceiling whenever either constant moves again. */
export const BB_INTAKE_CENTRE_FRAC = 0.6;
/** NEW. Acceleration (in/s²) an element's grip velocity ramps toward `BB_INTAKE_DRAW_IN` at, in
 * `bbIntakeAct`. Fixes a units bug: that function used to pass `BB_INTAKE_DRAW_IN` straight into
 * `approach()`'s per-tick `maxDelta`, i.e. a velocity as if it were a per-TICK displacement cap —
 * effectively 52 in/s ÷ (1/60 s) = 3120 in/s² of acceleration, reaching full draw-in speed from
 * rest in exactly one tick (instant velocity, reads as a teleport/jerk). 1200 in/s² gives a
 * 0.043–0.07 s (2.6–4.2 tick) ramp to today's/tomorrow's `BB_INTAKE_DRAW_IN`, well under one feed
 * period, so it smooths the motion without becoming the new bottleneck. APPROX — no published
 * intake spec exists to measure the real number against, same caveat this file already carries
 * for `BB3_ELEMENT_MASS`. */
export const BB_INTAKE_GRIP_ACCEL = 1200;
/** the FEED THROAT, as a fraction of the mouth's lateral half-span. An element has to be drawn
 * into this band to be swallowed — everything else is the funnel's job, and it costs TIME. */
export const BB_INTAKE_THROAT_FRAC = 0.72;
/** how far past the roller line an element's CENTRE may be (on top of its own radius) and still
 * count as touching the rollers. A contact tolerance, not extra reach: in 3D the chassis
 * collider is `robotExtents` — the roller line itself — so an element resting on it sits within
 * a hair of the rect bound and a strict test missed it entirely (measured: 0/1 at the mouth's
 * lateral edge, and 35–70 ticks where 2D took 15). */
export const BB_INTAKE_LIP = 0.35;
/** how far INBOARD of the frame face an element must have been drawn to be swallowed — the
 * throat depth. With `BB_INTAKE_DRAW_IN` this is what makes a capture a SHORT TRANSIT (~3–6
 * ticks from the roller line) instead of a teleport out of the whole mouth rect. */
export const BB_INTAKE_SEAT = 1.1;
/** seconds per element through the feed: `MIN` dead centre on the roller, `MAX` at its lateral
 * edge or on a wall grab. One real FTC intake passes an element every 0.15–0.3 s.
 * WAS 0.15 / 0.3. Halved to 0.06 / 0.12 (owner: cadence "way faster") — MEASURED against the
 * live gate (`world.time - lastIntakeAt < period`, `bbIntakeAct`), not just the doc comment:
 * today's real cadence, driven through the actual pipeline, is 0.10–0.19 s/element parked dead
 * centre and 0.10–0.13 s driving in with the closing bonus — already close to the old MIN, so
 * halving both bounds is the direct, verified lever. New range with the closing bonus applied:
 * 0.0375 s (driving in hard) to 0.06 s (parked dead centre) per lane-burst; new worst case
 * (lateral edge / wall grab) is 0.075–0.12 s, still faster than the OLD best case (0.09375 s),
 * so the whole range strictly improves. */
export const BB_INTAKE_PERIOD_MIN = 0.03;
export const BB_INTAKE_PERIOD_MAX = 0.06;
/* HALVED AGAIN 2026-09-20 (owner: "intaking cadence still needs to be way faster") — 0.06 / 0.12 →
 * 0.03 / 0.06, i.e. two to four elements a tick-pair through one lane, 17–33 per second per lane.
 * The transit (`BB_INTAKE_DRAW_IN`, capped under `C.BALL_MAX_SPEED` by the RULES lane) is now the
 * larger share of a capture's time, not the feed. */
/** inches of roller per FEED LANE. A bar wide enough for two paths into the hopper can take two
 * elements side by side in one cycle; a narrow one takes one. */
export const BB_INTAKE_LANE_W = 9;
/** driving INTO an element helps: the period is divided by up to `1 + BONUS` as the element's
 * inboard closing speed relative to the robot reaches `CLOSE_REF` in/s. */
export const BB_INTAKE_CLOSE_REF = 30;
export const BB_INTAKE_CLOSE_BONUS = 0.6;
/** an element crossing the mouth SIDEWAYS faster than this (in/s, relative to the robot) is not
 * gripped at all — the rollers spin under it and it carries on past. */
export const BB_INTAKE_CROSS_MAX = 80;
/** wall clearance (in, past the element's own skin) under which an element counts as PINNED and
 * is taken wherever it lies across the roller, at the slow end of the timing. A funnel cannot
 * centre something a wall is holding — DECODE learned this as "I can't intake a ball in the
 * corner anymore" and `INTAKE_WALL_GRAB` is the same rule. */
export const BB_INTAKE_WALL_GRAB = 1.2;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — launcher geometry (the four archetypes)
// ─────────────────────────────────────────────────────────────────────────────

export const BB_DEFAULT_SCORE_MODE: BbScoreMode = 'turret';

/** turret slew rate (rad/s). A turret does NOT snap to a heading — it swings at a finite rate,
 * which is why a turreted robot must spawn already pointed at its target rather than spending
 * the first second of auto rotating. APPROX: CR's tuned value, and turret hardware has not
 * changed.
 *
 * ⚠️ IT IS THE RATE AND NOT THE WHOLE MOTION — see `BB_TURRET_ACCEL` below. */
export const BB_TURRET_SLEW = 7;

/**
 * ⚠️ **A TURRET HAS AN ACCELERATION, NOT ONLY A RATE** (owner, 2026-09-19: "animate the turret
 * properly ... make the turret be fairly fast though"). rad/s² on the YAW axis.
 *
 * A rate-only clamp is a machine that reaches full speed in one tick and stops dead in one tick,
 * which is precisely what reads as un-animated: the drawn barrel jumps to a constant sweep and
 * then freezes. `bbSlewTurret` runs a rate- AND acceleration-limited profile now, and this is the
 * second half of it. The profile is the discrete "accelerate, cruise, decelerate into the target"
 * one — no overshoot, no oscillation, and every velocity change inside this cap (`slewAxis`,
 * `robot.ts`).
 *
 * MEASURED at the shipped pair (7 rad/s, 70 rad/s²), a parked turret swung onto a static target,
 * to the exact bearing with the rate back at zero: **30° in 0.183 s, 90° in 0.333 s, 180° in
 * 0.550 s**, peak rate 7.000, peak acceleration 70.0, overshoot **0.00**. The owner asked for
 * 0.25–0.35 s on the 90° swing. The closed form is `|e|/W + W/A` = 1.5708/7 + 7/70 = 0.324 s and
 * the discrete profile pays a third of a tick over it; a rate-only clamp would do the same swing
 * in 0.224 s and read as a jump.
 *
 * ⚠️ AND IT IS NOT FAST ENOUGH TO TRACK PERFECTLY, WHICH IS THE POINT (owner: "this does mean
 * that perfect tracking is not possible"). MEASURED driving flat out past the HIVE at 77–78 in/s:
 * steady-state yaw error **mean 0.5–1.3°, p95 1.2–6.0°** (worst at the closest standoff, where
 * the bearing sweeps fastest), and **75–100% of released shots score**. On a HARD REVERSAL of the
 * drive stick the lead solution jumps and the barrel is left **22–24° behind**, recovering in
 * **0.60 s (2D) / 0.75 s (3D)** — during which Aim Assist's landing gate released **0** shots,
 * i.e. the shot waits rather than missing. APPROX.
 */
export const BB_TURRET_ACCEL = 70; // APPROX

/** the ELEVATION axis's acceleration cap (rad/s²), the twin of `BB_TURRET_ACCEL`. Deliberately
 * sized so the pitch axis reaches its (already slow) `BB_TURRET_PITCH_SLEW` in ~0.13 s: elevation
 * carries the barrel's weight, so it is the slower axis in BOTH terms. MEASURED: level → the 80°
 * cap takes **1.005 s** (60 ticks) against 0.873 s for a rate-only clamp. APPROX. */
export const BB_TURRET_PITCH_ACCEL = 12; // APPROX

/** heading error (rad) under which a TURNED robot counts as aimed, and the P-gain that turns
 * it. Only turretless archetypes use these: the fire button steers the chassis. APPROX. */
export const BB_AIM_TOL = 0.14;
export const BB_AIM_GAIN = 4.5;

/** fraction of the chassis width a turretless launcher's parallel launch LINE spans. Slightly
 * under 1 so the outermost POLLEN of a burst is not born exactly on the frame line. APPROX. */
export const BB_LAUNCH_LINE_FRAC = 0.92;

/** launch height (in) — how high off the tile a POLLEN leaves the mechanism.
 *
 * ⚠️ THIS IS A HEIGHT, AND IT WAS ALSO BEING USED AS A VERTICAL VELOCITY. Every launch path in
 * `robot.ts` used to pass it as the `z` of the velocity `Vec3` handed to `releasePollen`, as
 * well as `elements.ts` using it (correctly) as `held.z`. So every POLLEN left at 10 in/s
 * upward and apexed 0.13 in: there was effectively no arc in this game. The velocity use is
 * gone — a launch's vertical speed is now solved from the target's height (`bbSolveShot`) or
 * set by the hood angle — and this is a height and only a height. The name is left alone
 * because renaming it touches Lane A's `elements.ts`; that is a separate cross-lane change.
 *
 * ⚠️ **IT IS THE DUMPER'S RELEASE NOW, AND ONLY THE DUMPER'S** (owner, 2026-09-19). A TURRET's
 * muzzle is the hood lip, which swings about the flywheel axle, so its release moves with the
 * elevation: `bbMuzzleLocal` / `bbMuzzleZ` (`robot.ts`) are the one answer, and every turret
 * consumer — the solve, `releasePollen`, stage 5b's landing prediction, the bot's verdict and
 * `shotPath.ts` — reads them. A tipping tray has no hood and no swing, so a dump still leaves
 * here, flat, at every distance. Do not re-point the dumper at the turret's function. */
export const BB_LAUNCH_Z0 = 10;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — mechanism composition (launcher elevation, the lift)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE BOX TUBE'S PLACEMENT POINT — how far past the collision footprint, along the tube's mount
 * direction, the point a FLOWER must be near sits (in). APPROX.
 *
 * FLOWER scoring is a PROXIMITY action (owner ruling 2026-09-12), not a raise: there is no
 * carriage height and no travel. `bbPlacePointLocal` (`robot.ts`) is the one geometry, and it is
 * sized against the FLOWER solid (`BB_FLOWER_FOOT`, CAD-regenerated `deep` 5.013, ring
 * `BB_FLOWER_D` = 2.629 off the wall): a chassis face flush on the flower is 5.013 − 2.629 =
 * 2.384 in past the ring centre. The reach is DERIVED as exactly that, so a robot pressed square
 * against a FLOWER foot has its placement point dead on the ring.
 *
 * WAS cited as 4.9 / 2.54 / 2.36 before the CAD regeneration (`fieldDims.gen.ts`); the VALUE was
 * always derived and correct, only this prose had drifted.
 */
export const BB_PLACE_REACH = BB_FLOWER_FOOT.deep - BB_FLOWER_D; // 2.384 — flush on the foot = dead centre
/** how close the placement point must be to a FLOWER ring centre to place (in). APPROX — the
 * slop of a real tube lining up on a 4.0-in ring; a placement should not need the pixel. */
export const BB_PLACE_TOL = 2.0;
/** how often a running intake pulls one POLLEN out of a FLOWER's retrieval opening (G418.B), in
 * seconds. APPROX — one element worked out from under the stack through a 3.55-in hole, not a
 * roller sweeping loose elements off the tiles, so it is slower than a ground pickup. */
export const BB_FLOWER_RETRIEVE_S = 0.15;
/* WAS 0.35. Cut to 0.15 with the ground cadence (owner, 2026-09-20: "way faster"): a column of
 * eight empties in 1.2 s instead of 2.8. */
// `BB_FLOWER_RETRIEVE_PAD` (the old flat-rect padding this constant used to be) is GONE: the
// gate below is archetype-aware and asks an actual overlap (`BB_FLOWER_BITE`) instead of a
// padded rect, so there is nothing left for a slop constant to pad.

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — intake ARCHETYPES, and what each one can physically reach in a FLOWER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **THE RETRIEVAL OPENING, MEASURED, AND WHY THE SWEEPER CANNOT USE IT** (owner, 2026-09-20:
 * "intaking from the flower is not physically accurate. Current rollers cannot actually reach the
 * pollen under").
 *
 * The bottom POLLEN of a FLOWER sits ON THE TILES inside the lower plate's 3.222-in bore (a 2.8-in
 * POLLEN falls through it — `sim3d/flowerTube.ts`), centre `BB_POLLEN_R` up and on the ring axis,
 * which is `BB_PLACE_REACH` (2.384 in) BEHIND the foot's field-side face. The space it sits in,
 * off the CAD hulls (`scratch` probe on F1, ring-centre frame, u into the field):
 *
 *   mid plate underside   z 3.904               the ceiling (`BB_FLOWER_RETRIEVE_Z[1]`)
 *   lower plate top       z 0.354, to u 2.404   a rim the POLLEN's bottom is 0.354 BELOW
 *   peanut supports       u −2.45 … −1.19       the only solids under the mid plate: wall side
 *   plate half-width      ±2.97 along the wall
 *
 * So the opening is open from the plate's field edge 3.57 in back to the supports, 3.55 in tall,
 * the full plate width — the manual's "3.55 in tall and 3.57 in deep" (§9.7) to the hundredth —
 * and a POLLEN in it is reachable by anything that can get **more than 0.98 in past the plate
 * edge, under 3.9 in, at POLLEN height**. The SWEEPER's roller is a 4.5-in axle with 2-in
 * compliant flaps whose lowest sweep is 2.5 in at the axle, TWO INCHES BEHIND the tip line: at the
 * tip line the flaps are at axle height, above the mid plate. Nothing on it ever passes the plate
 * edge, so `bbFlowerAtIntake` refuses it — which is what this section exists to say in numbers.
 *
 * Each archetype's REACH is one box in the MOUTH frame (`bbMouthFrame`: +x OUTWARD past the tip
 * line, y across the mouth, z off the tiles) — the volume of the hardware that touches the
 * POLLEN. The sim asks whether that box BITES the POLLEN (`BB_FLOWER_BITE` of overlap along both
 * x and z, and the POLLEN's centre within `half` of the mouth's centreline), and BOTH renderers
 * draw the hardware from these same numbers, so the drawn part that reaches is the part the sim
 * credits — the `bbMouths` rule, one mechanism further out.
 */
export interface BbFlowerReach {
  /** the hardware's extent OUTWARD of the tip line (in): `[inner, outer]`. Negative is behind
   * the tip, inside the mouth. */
  out: readonly [number, number];
  /** how far off the mouth's centreline the POLLEN's centre may sit and still be gripped (in).
   * `null` ⇒ anywhere across the mouth (a full-width part), unless `edgeGrip` is set. */
  half: number | null;
  /** EDGE-MOUNTED, SOLID hardware (the side rollers): the part sits at `±bbSideRollerY(mouthHalf)`
   * off the centreline (`out`'s own midpoint gives its distance past the tip line), and this is
   * the CONTACT RADIUS — the POLLEN is gripped when its centre sits within this distance of
   * EITHER wheel's own axis, in the mouth's full (u, v) plane, not a separate lateral band plus
   * an independent x-bite (`out` is unused for the longitudinal test when this is set; it only
   * locates the wheel's own axis). A solid wheel can never overlap a POLLEN, so this is a radius
   * around a point, not a box. */
  edgeGrip?: number;
  /** the hardware's z band off the tiles (in). */
  z: readonly [number, number];
}

/** the least overlap, along x AND along z, between a reach box and the POLLEN's own extent for
 * the hardware to count as having hold of it (in). APPROX — half an inch of a compliant wheel's
 * face or a ramp's lip under a ball, i.e. contact and not a graze. */
export const BB_FLOWER_BITE = 0.5;

/**
 * the SIDE ROLLERS (`siderollers`): two vertical-axis compliant wheels AT THE INTAKE'S EDGES,
 * one at each end of the mouth, hung from a gusset off the SIDE ARM'S OWN NOSE — TUCKED IN
 * front of the drive wheels, not out on a separate outrigger (owner, 2026-09-20: "The side
 * rollers should be right in front of the wheels. They should not be sticking out like that" —
 * the previous build hung each wheel `BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R` = 2.65 in past the
 * tip line on its own brace off the front brace). A wheel's axis is `bbSideRollerY(mouthHalf)`
 * off the centreline — its outer face 0.1 in inside the side arm's plane — so the pair is as
 * wide as the chassis and a ground POLLEN met at the mouth's end is walked inward toward the
 * roller.
 *
 * AT A FLOWER that means ONE wheel does the work: the pair is 12–17 in apart and cannot straddle
 * a 2.8-in ball, so the driver lines an END of the intake up on the opening — the chassis
 * `bbSideRollerY` off the flower's centreline — and that wheel enters the opening beside the
 * POLLEN.
 *
 * ⚠️ **LARGER DIAMETER, 2026-09-20** (owner: "the side roller should also be larger in
 * diameter" — a 3-in compliant wheel, up from the 2-in stack the tuck pass shipped).
 * `BB_SIDE_ROLLER_R` 1.0 → 1.5, and `BB_SIDE_ROLLER_OUT` 0.9 → 0.4 so the wheel still pokes the
 * SAME 1.9 in past the tip line the tuck pass measured (`OUT + R` unchanged: 0.9 + 1.0 = 0.4 +
 * 1.5) — the wheel now spans −1.1 … 1.9 in about the tip line, and the extra diameter goes
 * BACKWARD, further under the side arm's own nose, right in front of the drive wheel, rather
 * than poking out any further. `bbSideRollerY(mouthHalf)` = mouthHalf − (R + 0.1) is unchanged
 * in form, so the outer face still sits 0.1 in inside the arm's plane; a bigger `R` only pulls
 * the axis further inboard (1.6 in now, was 1.1). Height/Z unchanged: 0.5–2.5 in, under the
 * 3.904-in ceiling.
 *
 * ⚠️ **THE RETRIEVAL GATE IS CONTACT NOW, NOT A BOX-BITE** (owner, 2026-09-20: "side rollers
 * should also be colliding with everything. It is a physical thing"). The wheel is a real solid
 * cylinder in 3D (`chassis3dReachShapes`/`reachColliderDesc`, `sim3d/bodies.ts`) now, in the
 * DEFAULT collision group rather than `GROUP_POCKET` — it meets a POLLEN, a wall, another
 * robot, everything — so it can never overlap one, and the old box-BITE test (a fixed x-window
 * against `reach.out`) stopped matching what a real drive-in lands inside (a previous pass
 * papered over the mismatch by teleporting the robot in the smoke check rather than fixing the
 * gate). `bbFlowerAtIntakeMouth` (`play.ts`) tests CONTACT instead for `edgeGrip` hardware: the
 * xy distance from a wheel's own axis to the POLLEN's centre, in the mouth's (u, v) plane,
 * against `BB_SIDE_ROLLER_GRIP` below — which is now a RADIUS (`R + BB_POLLEN_R +
 * BB_SIDE_ROLLER_CONTACT_TOL`), not a lateral half-band. 2D has no solid wheel (`docs/area/
 * biobuzz.md`: "2D stays DRAWING-ONLY"), so there the robot CAN overlap; the same ≤ test, with
 * no lower bound, still works there — it just never binds as tightly as it does in 3D, where the
 * solid wheel keeps the true distance pinned near the contact radius.
 *
 * ⚠️ **HOW FAR THE WHEEL HAS TO STICK OUT, MEASURED — 1.004 in IS THE FLOOR, 1.65 IS SHIPPED**
 * (owner, 2026-09-21: "do the side roller wheels need to stick out that much for flower intaking?
 * it looks ugly and not the most realistic in terms of packaging", and again on the first pass'
 * answer: "still sticking out a ton"). Both halves were probed on the
 * real 3D colliders (`scratch/srgeom.ts` for the geometry, `scratch/sidesweep.ts` for the driving)
 * and the answer came out in two parts that point opposite ways:
 *
 *  1. **WHAT THE CHASSIS STOPS AGAINST IS THE FLOWER'S OWN RING PLATES, ON THE TIP LINE.** A
 *     BIOBUZZ chassis is ONE RECTANGULAR PRISM to a static — frame + side arms + lintel + the
 *     pocket filler (`chassis3dPocketShapes`, which exists because a fork drove over the hive's
 *     foot bars) — so its whole front face, full width, floor to roof, stops at `uOut`. Off the
 *     CAD hulls in the approach frame (`u` out of the wall, 0 = the ring axis): the LOWER RING
 *     PLATE is `u ≤ 2.404`, `z −0.199 … 0.354` and the MID PLATE is `u ≤ 2.415`, `z 3.904 …
 *     5.254`; between them the retrieval window is clear from 2.404 back to the peanut supports
 *     at −1.185, the full ±2.976 plate width. So the tip line rests on **2.404** (MEASURED on a
 *     real square drive-in: 2.4145) — `BB_PLACE_REACH` 2.384 to within 0.03 in — and only the
 *     wheel, which lives at `z 0.5 … 2.5`, gets through the window. The bottom POLLEN's near
 *     surface is `BB_POLLEN_R` from the ring axis, so the wheel's own front must reach
 *     `2.404 − 1.400` = **1.004 in past the tip line** to touch it at all. Below that no
 *     tolerance saves it: the two bodies are not in contact and widening
 *     `BB_SIDE_ROLLER_CONTACT_TOL` to cover the gap would be a fake.
 *  2. **AND EVERY THOUSANDTH ABOVE THAT FLOOR IS SPENT ON RECOVERING FROM YAW.** Two populations,
 *     both real drive-ins with no teleports, and they do NOT agree — which is the whole of why the
 *     cut stopped where it did:
 *
 *       protrusion         1.90   1.85   1.80   1.75   1.70  |1.65|  1.60   1.50   1.45   1.40
 *       held-intake all   73.3%  68.5%  64.4%  60.0%  63.9% |63.9%| 57.6%  60.0%    -    60.0%
 *       held straight-on   100%   100%   100%   100%   100% | 100%| 99.4%   100%    -     100%
 *       PARK then intake  61.1%     -      -      -      -  |58.3%| 44.4%  33.3%   0.0%   0.0%
 *
 *     (held-intake: 540 runs, 5 lateral offsets × 3 approach angles × 3 sticks × 3 column heights
 *     × 4 FLOWERS, the trigger held through the approach. PARK: 36 runs, drive in with the intake
 *     OFF, let the chassis settle, THEN hold it — `scratch/sidesweep.ts`, `SS_MODE=park`.)
 *
 *     The held-intake sweep alone would allow **1.40**: a driver holding the trigger takes the
 *     POLLEN on the way in, a mean 0.24 s after the mouth reaches the opening, and never sees the
 *     settled pose. But a chassis driven into a FLOWER meets the ring plate over only ONE SIDE of
 *     its own width — the driver is offset `bbSideRollerY` to put a wheel on the opening — so the
 *     normal force is a long lever and the pose picks up **18–22° of yaw** as it settles, which
 *     swings the gripping wheel out. REACH is what covers that yaw, and at 1.45 and below a
 *     driver who rolls up and only then presses the trigger gets **nothing at all**. 1.65 is the
 *     largest cut that costs neither population anything measurable (58.3 % against 61.1 %,
 *     straight-on still 180/180), and `scripts/smoke-biobuzz/flower3d.ts`'s own F1 drive-in
 *     fixture is the canary: driven in with the intake OFF and asked once at the settled pose it
 *     bites at 1.90 and at no smaller value at all, so that fixture now holds the trigger through
 *     the drive and its header carries this table.
 *
 * ⚠️ **AND THE BRACKET MAY NOT COVER THE WHEEL** (owner, 2026-09-21, rejecting the first pass at
 * this section, which kept 1.90 and answered the complaint with packaging alone: "The side
 * rollers are rendered as being covered and still sticking out a ton. It cant be covered fully
 * because it needs to actually touch the balls"). That draft capped each wheel with a retainer
 * plate on the wheel's OWN radius — in plan, the whole wheel. It is a REAR YOKE now: a strap
 * above and a strap below, both running diagonally from the side arm's rail to the AXLE and
 * stopping there in a `BB_SIDE_ROLLER_BOSS_R` bearing boss, with nothing drawn forward of the
 * axle line except that boss and **223° of tread** left visible from every angle, full height.
 * The wheel itself is a hub with a lugged compliant tread. Both renderers build it and the RENDER
 * lane measures the open arc off the built meshes' own vertices rather than trusting the numbers.
 */
export const BB_SIDE_ROLLER_R = 1.5;
/** the wheel's height (in): a 2-in compliant wheel stack. */
export const BB_SIDE_ROLLER_H = 2.0;
/** the wheel's mid-height off the tiles (in) — a hair above a POLLEN's own centre. */
export const BB_SIDE_ROLLER_Z = 1.5;
/** the wheel's axis, past the tip line (in) — NEGATIVE: the axis sits just INSIDE the footprint
 * and only the wheel's front quadrant stands proud. See `BB_SIDE_ROLLER_PROTRUDE`. */
export const BB_SIDE_ROLLER_OUT = 0.15;
/** how far the wheel's own FRONT stands past the tip line (in) — the one number the owner asked
 * about, and the one the wall standoff, `bbArchetypeWallExtra`, `bbIntakeExtraReach` and both
 * drawings all read. FLOOR **1.004** (the wheel cannot otherwise touch a FLOWER's bottom POLLEN
 * with the chassis prism stopped on the ring plates); shipped **1.65**, the largest cut off the
 * old 1.90 that costs neither retrieval population anything measurable — see this section's own
 * header for the two sweeps that fix both ends. */
export const BB_SIDE_ROLLER_PROTRUDE = BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R;
/** the yoke's own sheet (in): the plate above the wheel and the plate under it, both cantilevered
 * off the side arm's rail and stopping at the AXLE. The BOTTOM plate is what sets this — it has
 * to fit between the wheel's underside (`BB_SIDE_ROLLER_Z − H/2` = 0.5) and the FLOWER's lower
 * ring plate rim (0.354 in, the one thing at that height the module drives over), which leaves
 * 0.146 in; 0.12 is the nearest real sheet with clearance left (0.026 in). */
export const BB_SIDE_ROLLER_PLATE_T = 0.12;
/** how far BACK along the side arm the yoke's plates run from the wheel's axis (in) — far enough
 * inboard of the arm's own nose that the module reads as bolted along the rail rather than hung
 * off its end. Drawing only; nothing in the sim reads it. */
export const BB_SIDE_ROLLER_YOKE_BACK = 2.4;
/**
 * ⚠️ **THE BRACKET IS A REAR YOKE AND IT MAY NOT COVER THE WHEEL** (owner, 2026-09-21, rejecting
 * the housed module: "The side rollers are rendered as being covered and still sticking out a
 * ton. It cant be covered fully because it needs to actually touch the balls"). The plates run
 * from the arm to the AXLE and stop there in a bearing BOSS of this radius; nothing is drawn
 * forward of the axle line except that boss, and nothing caps the wheel's radius. The yoke STRAP
 * is `BB_SIDE_ROLLER_YOKE_W` wide and rides on the arm rail's own centreline, which is what keeps
 * the working arc open: MEASURED off the rail's `armY` on the default chassis, the strap first
 * occludes the wheel from above at **111.6°** off the outward direction, so **223°** of tread —
 * the whole forward and outboard working arc — is visible from every angle, full height. A
 * 0.9-wide strap (the first draft) starts occluding at 90° and leaves only 180°.
 */
export const BB_SIDE_ROLLER_BOSS_R = 0.55;
/** the yoke strap's width (in) — see `BB_SIDE_ROLLER_BOSS_R` for the 223°-of-tread measurement
 * this number is chosen by. */
export const BB_SIDE_ROLLER_YOKE_W = 0.5;
/**
 * how far inboard of the mouth's lateral edge the yoke strap rides (in): the side ARM RAIL's own
 * centreline, `BB_INTAKE_ARM_INSET` (`BB_PLATE_T` 0.22 + 0.06) plus half a rail (`INTAKE_RAIL_T`
 * 0.5). Both of those live in `scene/renderRobots.ts`, which `drawRobot.ts` may not import (the
 * lazy-chunk boundary the RENDER lane enforces), so the ONE number both drawings place the yoke
 * by lives here instead of being typed twice — the same treatment `bbSideRollerY` gets, and the
 * RENDER lane asserts it against the 3D arm's own `armY` rather than trusting it.
 */
export const BB_SIDE_ROLLER_YOKE_INSET = 0.53;
/** the yoke strap's own y off the mouth's centreline, for a mouth of half-width `mouthHalf` (in).
 * ONE placement, read by the 3D scene, the 2D sprite and the checks. */
export function bbSideRollerYokeY(mouthHalf: number): number {
  return mouthHalf - BB_SIDE_ROLLER_YOKE_INSET;
}
/** the wheel's own HUB radius (in): a moulded centre with the compliant tread lugged round it,
 * the same hub-and-lug language the sweeper's barrel uses. Drawing only — the SOLID is the full
 * `BB_SIDE_ROLLER_R` cylinder, and the drawn lugs' outer corners land exactly on it. */
export const BB_SIDE_ROLLER_HUB_R = 0.62;
/** how far INBOARD of the mouth's lateral edge a wheel's axis sits (in): its own radius plus a
 * 0.1-in clearance to the side arm's plane. */
export const BB_SIDE_ROLLER_EDGE_INSET = BB_SIDE_ROLLER_R + 0.1;
/** a wheel's axis off the mouth's centreline, for a mouth of half-width `mouthHalf` (in) — the
 * ONE placement both renderers, the collider and the retrieval gate read. */
export function bbSideRollerY(mouthHalf: number): number {
  return mouthHalf - BB_SIDE_ROLLER_EDGE_INSET;
}
/** the solver's own contact skin plus compliance (in) — how much a POLLEN and a wheel may sit
 * apart, centre to centre, past the sum of their radii and still count as touching. APPROX: a
 * compliant wheel's own give plus Rapier's narrow-phase margin, not a measured spec.
 * MEASURED against a REAL drive-in (`scripts/smoke-biobuzz/flower3d.ts`'s "drive-in" fixture,
 * `chassis3dReachShapes`'s wheels now solid): a full-stick approach picks up 18° of yaw drift and
 * 2.5in of lateral drift off the asymmetric wheel contact (the same contact-torque effect
 * `docs/area/physics.md` documents for robot-robot pushing) and settles at 3.162in from the
 * gripping wheel's own axis — 0.25 left the gate refusing a real drive-in by 0.012in; 0.35 covers
 * it with an 0.09in margin. */
export const BB_SIDE_ROLLER_CONTACT_TOL = 0.35;
/** how far a POLLEN's centre may sit from a wheel's own axis, in the mouth's (u, v) plane, and
 * still count as gripped (in) — the CONTACT radius: the two bodies' radii plus the solver's own
 * skin (`BB_SIDE_ROLLER_CONTACT_TOL`). Read as `BbFlowerReach.edgeGrip`, which `bbFlowerAtIntakeMouth`
 * (`play.ts`) now tests as a RADIUS rather than a lateral half-band — see this section's own
 * header for why a solid wheel needed the change. */
export const BB_SIDE_ROLLER_GRIP = BB_SIDE_ROLLER_R + BB_POLLEN_R + BB_SIDE_ROLLER_CONTACT_TOL;
export const BB_SIDE_ROLLER_REACH: BbFlowerReach = {
  out: [BB_SIDE_ROLLER_OUT - BB_SIDE_ROLLER_R, BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R],
  half: null,
  edgeGrip: BB_SIDE_ROLLER_GRIP,
  z: [BB_SIDE_ROLLER_Z - BB_SIDE_ROLLER_H / 2, BB_SIDE_ROLLER_Z + BB_SIDE_ROLLER_H / 2],
};
/**
 * ⚠️ **THE SIDE-ROLLER RELEASE'S OWN OFFSET — THREE DRAFTS, THREE MEASURED FAILURES BEFORE THIS
 * ONE.** `flowerRetrieve3d`'s `siderollers` branch (`sim3d/flower3d.ts`) is a PHYSICAL release
 * like the ramp's — a `ground` element the extended pull (`bbIntakeExtraReach`) sweeps in, not a
 * teleport into the hopper — and getting the release POINT right took three wrong ones:
 *
 *  · Draft 1 retreated `BB_FLOWER_OPEN_R + 0.3` INWARD along `u` from the flower's own axis,
 *    leaving `v` at the true lateral position (`≈ bbSideRollerY`, 6.9 in on the default chassis).
 *    `v` that large was never the risk — MEASURED, it clears the 2.086-in tube radius on its own,
 *    for any `u`. The real hazard was `u`: retreating inward at all runs straight into the wheel's
 *    own solid span (`u ∈ [BB_SIDE_ROLLER_OUT ∓ R]` past the tip line, now a real cylinder) —
 *    MEASURED, the release landed dead centre inside it, and a continuous drive through that
 *    overlap threw the element clear across the field the very next tick (Rapier's own
 *    deep-penetration recovery, not a gameplay bounce).
 *  · Draft 2 retreated further still, to just BEHIND the wheel's own inner edge, mirroring the
 *    ramp's "just behind the crossbar". MEASURED: the pocket a side-roller archetype retreats
 *    into is only `bbIntakeReach` deep (3 in on the default chassis) and the wheel's own span
 *    already reaches 1.1 in into it, leaving under 2 in for a 2.8-in POLLEN to occupy without
 *    ALSO touching the frame face on the far side — 0.2 in of headroom, not enough for a body its
 *    own size. Same failure as draft 1, for the opposite reason.
 *  · Draft 3 left `u` AND `v` both exactly where the POLLEN already was (the flower's own true
 *    axis, `(f.x, f.y)`) on the theory that a gripping wheel already presses into the ball a
 *    little by construction (the old box-bite model's own "0.15 in of compression") and Rapier
 *    resolves a small, PRE-EXISTING overlap as an ordinary contact force. MEASURED WRONG THE
 *    OTHER WAY: the ball's WORLD position had not moved AT ALL, so it was still exactly on the
 *    flower's own axis — inside `BB_FLOWER_OPEN_R` by construction — and `derive.ts`'s tube test
 *    re-tagged it `element`/`flower:i` again on the very next tick. Invisible from outside (the
 *    stack never shrank), and `lastIntakeAt` kept climbing as the same release-then-retag cycle
 *    repeated every qualifying tick.
 *
 * `u` UNCHANGED, `v` SHIFTED, is what actually works, and both halves were measured, not assumed:
 * `u = u0` sits just PAST the wheel's own outer edge already (that is the contact condition —
 * measured 0.48 in clear on the default chassis), so it was never the hazard once draft 1 stopped
 * retreating INTO it; the ONE real distance that needed a deliberate move was `v`, toward the
 * mouth's centreline by more than the tube's own radius, which lands inside the retrieval
 * opening's documented OPEN band (`config.ts`'s own header on the opening: "the full plate width"
 * — no support stands in it at this height) and clears the wheel's lateral span in the same move.
 */
export const BB_SIDE_ROLLER_RELEASE_CLEAR = BB_FLOWER_OPEN_R + 0.3;

/**
 * THE DEPLOYABLE RAMP (`ramp`): a U-frame — two rails and a leading PLOW BLADE — pivoting on a
 * bracket under the intake's side arms. FOLDED it stands vertical with the sweeper's roller
 * inside the U (the rails either side of the barrel); DEPLOYED it drops forward and down and the
 * blade lies flat in the FLOWER's retrieval opening, skimming the lower ring plate, so a POLLEN
 * lifted onto it has a floor all the way back to the rollers. All APPROX — the sim's own
 * hardware model.
 *
 *   pivot   `BB_RAMP_PIVOT_BACK` behind the tip line (the sweeper's own axle line, so the folded
 *           rails stand round the roller), `BB_RAMP_PIVOT_Z` up
 *   rails   `BB_RAMP_L` long, `BB_RAMP_ANGLE` below level — solved so the rail's own tip lands
 *           exactly on the blade's lip
 *   blade   one LEVEL box, `BB_RAMP_IN` (0.85) … `BB_RAMP_OUT` (3.54) past the tip line,
 *           `BB_RAMP_FLOOR_Z` (0.40) underneath and `BB_RAMP_DECK_Z` (0.48) on top, rail to rail
 *
 * ── WHY IT IS A FLAT BLADE AND NOT THE WEDGE IT WAS, ALL FOUR MEASUREMENTS ───────────────────
 * The 2026-09-20 wedge (a lead edge at 0.60, a crest at 1.00, two tilted boxes centred on their
 * own profile line) never extracted a POLLEN by physics. `scratch/rampx.ts` drove it in for real
 * — `contactPairsWith` + `contactPair`, every manifold named — and the answer came in four parts:
 *
 *  1. **A TILTED BOX HANGS BELOW ITS OWN PROFILE LINE.** Its lowest corner is `2·thick·cos(angle)`
 *     under the point `config.ts` names, so a "lead z 0.42" wedge really reached **0.3067** —
 *     under the LOWER RING PLATE's own top face, **0.354**. That plate is an annulus 5.95 in wide
 *     with a 3.222-in bore and the ramp is rail-to-rail (±7.57 in), so everything outside the
 *     bore's own chord is over SOLID plate: the chassis froze 2.27 in short of flush. MEASURED
 *     with a free-shape `intersectionsWithShape`, which NAMES the collider — `LEAD_Z 0.42 ->
 *     trimesh z=[-0.199,0.354] FLOWER0` at every standoff, `0.50` and up CLEAR. The earlier CAD
 *     probe missed it because it sampled the wedge's CENTRELINE only, which is where the bore is.
 *  2. **RAISING THE LEAD TO 0.60 PUT THE LIP ON THE BALL'S FLANK INSTEAD OF UNDER IT.** A tilted
 *     box's OUTERMOST point is the TOP corner of its end cap (the cap leans out with the slope),
 *     which sat at **0.713**. A POLLEN on the tiles is tangent to a horizontal line at height `h`
 *     a distance `d(h) = sqrt(r² − (r−h)²)` from its own centre, and the ball backs onto the
 *     peanut supports, so the lip drives it along that contact normal: `d/r` sideways against
 *     `(r−h)/r` up. It LIFTS only while
 *
 *         (r − h) / d(h)  >  μ     (μ = ball-on-support friction, `CoefficientCombineRule.Max`:
 *                                   `max(BB3_ELEMENT_FRICTION 0.6, PHYS_WALL_FRICTION 0.65)`)
 *
 *     i.e. only while `h < BB_POLLEN_R·(1 − μ/sqrt(1 + μ²))` = **0.637 in**. At 0.713 the ratio is
 *     0.564 against μ 0.65 and the ball SELF-LOCKS: measured, the chassis stalled **1.47 in short
 *     of flush**, the POLLEN was driven 0.42 in onto the two supports (manifold normals
 *     `(0.89, ±0.46, 0)`) and 0.054 in INTO the tiles, and its centre never rose. The owner's "the
 *     pollen don't budge", exactly.
 *  3. **AND A TILTED LIP'S END CAP OVERHANGS, WHICH TRAPS THE BALL EVEN WHEN THE HEIGHT IS RIGHT.**
 *     The cap is perpendicular to the slope, so it leans OUT by the rise angle: its normal carries
 *     `−sin(rise)` of DOWN. Against the supports' horizontal normal that is a downward-closing V
 *     and the ball cannot rise out of it at any drive strength — MEASURED, a stacked column's
 *     bottom POLLEN did not clear at a roller speed of **160 in/s**, more than three times the
 *     shipped one.
 *     A LEVEL blade's leading face is VERTICAL: it presses the ball horizontally and the ball
 *     rides up it.
 *  4. **AND A CREST IS PURE COST.** Anything the ball has to climb to reach the deck has to lift
 *     the whole column with it, and the column is the owner's own suspect ("I think it depends on
 *     how the pollen are stacked"). MEASURED: a settled 8-column's bottom POLLEN sits **0.44 in**
 *     toward the wall, perched on the lower bore's rim — the cage's 0.548 in of slack, transmitted
 *     down — so it is already against the supports before the ramp arrives, which is the whole of
 *     the "it depends on how they are stacked" failure. A flat blade at 0.48 asks the column for
 *     0.48 in of lift and nothing more.
 *
 * So the owner's "a slight slope up and a larger slope down for it to first get under the pollen"
 * is honoured by the BLADE ITSELF rather than by a profile: the 0.08-in step at the lip is the
 * slope up (the POLLEN is lifted onto the deck as the blade slides in) and the deck's own inboard
 * end, 0.48 in above the tiles right at the roller line, is the slope down into the mouth.
 *
 * ── AND THE LIP IS DRIVEN ───────────────────────────────────────────────────────────────────
 * No PASSIVE profile extracts a leaning column, at any lip height that also clears the plate's
 * rim: `rampRollerDrive` (`sim3d/flower3d.ts`) carries that bound with its numbers. A real ramp
 * intake has a roller at the top of its lip, and `BB_RAMP_ROLLER_V` is it.
 *
 * `BB_RAMP_OUT` sits at the peanut supports' own limit (`BB_FLOWER_PEANUT_U`, 3.57 past the tip
 * line) minus `BB_RAMP_PEANUT_CLEAR`; MEASURED (`scratch/rampsup.ts`), those two hulls occupy
 * `u 1.19…2.45` at `|v| 0.62…1.89` in the ring frame and nothing else stands in the opening at
 * blade height, so the 1.24-in lane between them is the only way further out — and it moves with
 * the driver's own lateral offset, which is why the blade does not try to use it.
 *
 * `chassis3dReachShapes` builds the blade as ONE level box, the same `pitchQuatY` composition the
 * rails use (at angle 0), and NOT a `ColliderDesc.convexHull`: a hull would buy a true knife lip,
 * but `groundRoll3d`'s perched-element rule reads a `ConvexPolyhedron` as "a narrow CAD hull" and
 * would start vibrating every POLLEN resting on the ramp's own deck. `scene/renderRobots.ts`
 * draws the same box from the same four numbers.
 */
export const BB_RAMP_PIVOT_BACK = 2.0;
/**
 * ⚠️ **THE RAMP PIVOTS ON THE SWEEPER'S OWN SHAFT** (owner, 2026-09-21: "the ramp collides with the
 * intake rollers when it is folded up"). The pivot used to hang 2.3 in BELOW the axle on the same
 * `u`, so a folded (vertical) rail stood exactly where the roller's shaft runs from the barrel's
 * end into its bearing — a rail through an axle, at every width. On the shaft, the rail's eye IS
 * the bearing: nothing crosses anything, and every point of the blade stays 4.9 in from the axle
 * at EVERY swing angle, clear of the 2.0-in flap sweep without shortening the deck. It is how a
 * real over-the-roller ramp is carried. `BB3_MOUTH_SLOT_Z + 0.9` is `scene/renderRobots.ts`'s
 * `BB_ROLLER_Z` (the RENDER lane pins the two together); spelled from `BB_NECTAR_R` because
 * `BB3_MOUTH_SLOT_Z` is declared further down this file. The rails get steeper (18.7° → 36°) and
 * longer (5.8 → 6.9 in), so a folded ramp stands 11.4 in tall, still inside R102's cube.
 */
export const BB_RAMP_PIVOT_Z = 2 * BB_NECTAR_R + 0.9;

/** how far short of the peanut supports' own inner edge the ramp's lip stops (in). APPROX — the
 * supports' hulls start at z 0.35, i.e. at lip height, so this is a real hardware clearance and
 * not a margin on a number. It was 0.15; cut to 0.03 to buy the lip 0.12 in more reach past the
 * POLLEN's own centre, which is what the self-locking bound above spends. MEASURED at 0.05 first:
 * 400 lone-POLLEN drive-ins went 314/400 there and 400/400 here, and the difference is entirely
 * the 0.10 in of "under-ness" this buys at the lip (see `BB_RAMP_DECK_Z`). */
export const BB_RAMP_PEANUT_CLEAR = 0.03;
/** the peanut supports' own inner edge, past the tip line (in) — CAD probe, this file's own
 * "ROBOT — intake ARCHETYPES" section header (`u −2.45 … −1.19` in the ring-centred frame; the
 * near edge converts to `BB_PLACE_REACH − (−1.19)` = 3.574, rounded to the manual's own printed
 * depth, 3.57). */
export const BB_FLOWER_PEANUT_U = 3.57;

/**
 * ⚠️ **THE BLADE'S UNDERSIDE, FLAT AND LEVEL** (in). MEASURED against the LOWER RING PLATE, whose
 * top face is **0.354** and which the ramp skims the whole way in: that plate's own field edge
 * sits 2.404 in from the ring axis, i.e. AT the tip line when the chassis is flush, so no part of
 * a deployed ramp is ever NOT over it. 0.046 in of clearance — and the chassis body is yaw-only
 * with `RobotState.z` pinned at 0 while driving, so the gap is rigid rather than a tolerance. See
 * this section's header for the `intersectionsWithShape` run that named the plate.
 */
export const BB_RAMP_FLOOR_Z = 0.4;
/** the blade's own plate thickness (in, half-extent) — a 1/8-in sheet, not the 0.25-in bar the
 * first wedge was built from — 0.08 in overall. It is spent twice over: directly against the
 * 0.637-in self-locking bound above (the blade's top IS its outermost point), and against the
 * ball's own underside curve at the lip. MEASURED, the whole difference between 0.05 and 0.04 of
 * half-thickness is the 4-column slice going 399/400 to 400/400. Lives here (not
 * `sim3d/bodies.ts`) because `scene/renderRobots.ts` draws the same box and may not import the
 * lazy physics chunk. */
export const BB_RAMP_WEDGE_THICK = 0.04;

/** the blade's own outward reach past the tip line (in): as far under a flush POLLEN's own centre
 * (`BB_PLACE_REACH`, 2.384 — so 1.156 in past it) as the peanut supports allow. */
export const BB_RAMP_OUT = BB_FLOWER_PEANUT_U - BB_RAMP_PEANUT_CLEAR; // 3.54
/**
 * ⚠️ **THE BLADE'S INBOARD END** (in, past the tip line). Owner's own spec for this mechanism: *"when deployed, from the top down, it
 * should look like an upside down U shape. This is because the hole created by the U is where the
 * intake rollers are situated in when the ramp is folded up vertically."* So the U's OPENING has
 * to contain the sweeper's roller when the ramp is stowed, and the blade is the U's bight.
 *
 * The pivot is on the roller's SHAFT now (`BB_RAMP_PIVOT_Z`), so every point of the blade keeps
 * one distance from the axle through the whole swing: **4.93 in** at the inboard corner, 2.93 past
 * the r-2.0 flap sweep (`scratch/rampfold.ts`). `BB_RAMP_IN` therefore no longer has to buy
 * clearance — under the old low pivot 0.85 still left the blade 0.77 in inside the flap sweep, and
 * clearing it needed 2.05. Both values extract **400/400** on the 400-run grid (0.85: mean 0.285 s,
 * drain 72 ticks; 2.05: 0.293 s, 69), so 0.85 stays: the longer deck is the one the owner described
 * ("slides down towards the intake").
 */
export const BB_RAMP_IN = 0.85;

/**
 * ⚠️ **THE DECK — THE BLADE'S TOP SURFACE, AND THE ONE HEIGHT THE WHOLE MECHANISM TURNS ON** (in).
 * Derived, not typed: `BB_RAMP_FLOOR_Z + 2·thick` = **0.48**. Four things have to be true of it at
 * once and all four are measured, here or in this section's header:
 *
 *   · it is the blade's OUTERMOST point too (the leading face is vertical), so it has to sit under
 *     the **0.637** self-locking bound — 0.157 in of margin, i.e. the profile holds to μ = 0.87;
 *   · it has to sit under the ball's own underside curve at the lip's reach, `BB_POLLEN_R −
 *     sqrt(BB_POLLEN_R² − 1.156²)` = **0.610**, so the blade passes UNDER a POLLEN that has not
 *     been shoved back at all: the lip clears the tangency point by **0.101 in**;
 *   · a POLLEN resting on it has its BOTTOM at 0.48, clear of the lower plate's 0.354 rim, which is
 *     what `BB_RAMP_LIFT_Z` and `derive.ts` both read to know the ball has left the tube;
 *   · and it asks a loaded column for 0.48 in of lift, against the 1.0 in the old crest did.
 */
export const BB_RAMP_DECK_Z = BB_RAMP_FLOOR_Z + 2 * BB_RAMP_WEDGE_THICK;

/** how far below level the RAIL lies (rad) — solved so `BB_RAMP_L` at this angle lands the
 * rail's own tip exactly on the blade's lip (`BB_RAMP_OUT`, `BB_RAMP_DECK_Z`), pivot unchanged:
 * `L·sinθ = BB_RAMP_PIVOT_Z − BB_RAMP_DECK_Z`, `L·cosθ = BB_RAMP_OUT + BB_RAMP_PIVOT_BACK`,
 * `θ = datan2(…)` — the deterministic `atan2`, not `Math.atan2`, because this value is exported
 * and every peer must load the same bits. */
export const BB_RAMP_ANGLE = datan2(BB_RAMP_PIVOT_Z - BB_RAMP_DECK_Z, BB_RAMP_OUT + BB_RAMP_PIVOT_BACK);
/** the rail's own length (in), solved alongside `BB_RAMP_ANGLE` above: `(OUT + pivotBack) /
 * cos(angle)`. `Math.sqrt`/division are IEEE-754 correctly-rounded (unlike `Math.hypot` or
 * `Math.atan2`), so this is as safe for lockstep as `hyp` in `src/math.ts`. */
export const BB_RAMP_L = (BB_RAMP_OUT + BB_RAMP_PIVOT_BACK) / dcos(BB_RAMP_ANGLE);
/** the rail's tip height off the tiles (in): `pivotZ − L·sin(angle)` — reproduces
 * `BB_RAMP_DECK_Z` to within `dsin`'s own ~1e-11 error, which is the whole point of solving `L`/
 * `BB_RAMP_ANGLE` above rather than typing the deck height a second time. */
export const BB_RAMP_TIP_Z = BB_RAMP_PIVOT_Z - BB_RAMP_L * dsin(BB_RAMP_ANGLE);

/** how long the ramp takes to swing between its two poses (s). APPROX — a servo-driven drop;
 * the sim credits the ramp only once it has arrived (`bbRampSettled`), and the renderer eases
 * the same interval off `RobotState.bbRampAt`, so the drawn ramp and the credited one agree. */
export const BB_RAMP_DEPLOY_S = 0.3;
/** how deep a fixed body may press a SETTLED ramp vertically before it folds (in) — the 3D jam
 * guard in `elements3d.ts`'s `bbRampSwingStep3d`. Resting contact sits near `PHYS_ALLOWED_ERROR`
 * (0.01); the jam in replay 1dc6eb8f was 0.13 deep, the random-drive jams 0.38–0.45. */
export const BB_RAMP_EMBED_DEPTH = 0.05;
export const BB_RAMP_REACH: BbFlowerReach = {
  out: [0, BB_RAMP_OUT],
  half: null, // the full mouth width
  /**
   * ⚠️ **THE RAMP HARDWARE'S OWN Z BAND — THE BLADE'S UNDERSIDE UP TO THE PIVOT — NOT THE BLADE'S
   * SILHOUETTE.** This box has always been a claim about the HARDWARE rather than about one
   * surface (`half` is already `null`, "the full mouth width", which the rails are not), and the
   * deployed ramp genuinely occupies this whole band: the blade at the bottom, the two rails
   * climbing to `BB_RAMP_PIVOT_Z`.
   *
   * It matters because the PERMANENT 2D pipeline reads it: `retrieveFromFlower`'s z-bite asks
   * `BB_FLOWER_BITE` (0.5 in) of overlap against that model's fixed bottom-POLLEN span
   * `[0.354, 3.154]`, and the blade alone is 0.125 in thick. Pinning the band to the blade would
   * put the 2D ramp gate permanently dark; pinning the blade's top to 0.854 to satisfy the bite
   * instead would cost the column 0.33 in of lift for nothing (see `BB_RAMP_DECK_Z`). 2D's own
   * verdict does not move either way — the bite passed before at 0.58 in of overlap and passes
   * now at 1.80.
   *
   * The TOP is the rail's height where it crosses the TIP LINE, not the pivot: `out` only claims
   * what is past the tip, and the pivot (on the roller shaft since 2026-09-21, 4.5 in up) is 2 in
   * behind it. Past the tip the rails are at 3.05 in and falling — under the 3.904-in ceiling.
   */
  z: [BB_RAMP_FLOOR_Z, BB_RAMP_PIVOT_Z - ((BB_RAMP_PIVOT_Z - BB_RAMP_DECK_Z) * BB_RAMP_PIVOT_BACK) / (BB_RAMP_OUT + BB_RAMP_PIVOT_BACK)],
};

/**
 * ⚠️ **THE HEIGHT AT WHICH A FLOWER'S BOTTOM POLLEN HAS LEFT THE FLOWER** (in, the element's own
 * BOTTOM) — the ONE gate a `ramp` retrieval has, and it is a fact about the ball's body rather
 * than about the robot's pose. It replaced `BB_RAMP_STALL_S`, a 0.25-s timer after which the
 * retrieval teleported the POLLEN out because the wedge could not: with the profile above, the
 * wedge actually picks it up, so the bookkeeping only has to notice.
 *
 * Inside the tube there are exactly two things a POLLEN can rest on — the TILES (bottom 0) and
 * the element under it (bottom ≥ 2·BB_POLLEN_R) — plus the lower plate's own rim at 0.354, which
 * carries a NECTAR and never a POLLEN (a 2.8-in ball falls through the 3.222-in bore). So a
 * POLLEN whose bottom is above this line, inside the retrieval opening, is standing on hardware
 * the ROBOT brought: the ramp's deck, at `BB_RAMP_DECK_Z` = 0.48. Sits between the rim (0.354)
 * and the deck, at the ramp's own underside.
 *
 * `derive.ts` reads the same number for the other half of the same fact — see its "LIFTED CLEAR
 * OF THE BORE" note — because a ball on the deck is still inside `flowerTubeOf`'s bare 2.086-in
 * radius and would otherwise be re-claimed into the tube on the very next tick.
 */
export const BB_RAMP_LIFT_Z = BB_RAMP_FLOOR_Z;

/**
 * ⚠️ **THE RAMP'S LIP IS DRIVEN, AND A PASSIVE ONE PROVABLY CANNOT DO THIS JOB** (in/s — the
 * roller's own surface speed, up the nose's rise). The bound is in `rampRollerDrive`'s header
 * (`sim3d/flower3d.ts`) and it is not a tuning failure: a POLLEN met on its flank retreats
 * **0.458 in** onto the peanut supports before it wedges, the lip would then need to reach 1.541
 * in past the ball's centre to be under it, and the SAME supports cap the ramp's reach at 1.156.
 * The only lip height that beats it is `h ≤ 0.175`, under the lower plate's own 0.354 rim. So the
 * lip has a roller on it, which is what a real ramp intake has anyway, and it is on the intake's
 * own motor — it turns only while the driver holds the intake.
 *
 * A FRICTION DRIVE, not a teleport: it raises the ball's velocity COMPONENT along the lip's rise
 * direction to this and never reduces it, leaving everything else to the solver, so the POLLEN
 * still climbs the plate's rim and rides the blade under Rapier. MEASURED over the full 400-run
 * grid at several speeds (mean time from the ramp reaching the opening to POLLEN-in-hopper, by
 * column height 1/2/4/6/8, in ticks): **20 → 39/45/61/93/147, 30 → 39/42/51/61/81, 45 →
 * 39/40/46/52/61, 50 → best and flattest, 60 → a LONE pollen starts missing.** Fast enough to beat
 * `BB3_ROLL_DECEL`'s 12 in/s² floor damping by two orders, slow enough that the transit is visibly
 * a transit and a lone ball is walked rather than flicked.
 */
export const BB_RAMP_ROLLER_V = 50;

/**
 * WHAT THIS ARCHETYPE CAN REACH IN A FLOWER'S OPENING RIGHT NOW, or `null` for nothing: the
 * sweeper never, the side rollers always, the ramp only once deployed and settled (`rampReady`,
 * which is `bbRampSettled` in `robot.ts`). The ONE reader in the sim is `bbFlowerAtIntake`.
 */
export function bbFlowerReachOf(kind: BbIntakeKind, rampReady: boolean): BbFlowerReach | null {
  switch (kind) {
    case 'sweeper':
      return null;
    case 'siderollers':
      return BB_SIDE_ROLLER_REACH;
    case 'ramp':
      return rampReady ? BB_RAMP_REACH : null;
  }
}

/**
 * ⚠️ **HOW FAR AN ARCHETYPE'S OWN REACH HARDWARE STICKS OUT PAST `bbFootprint`'S OWN EDGE, FOLDED**
 * (in) — the one number `spawn.ts` needs to keep a wall-flush 3D start from POPPING (owner,
 * 2026-09-20: "It should be a collider."). MEASURED: a `siderollers` build's wheels sit
 * `BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R` = 1.9 in past the footprint's tip line (was 2.65 in
 * before the wheels were tucked in front of the drive wheels, 2026-09-20) — still enough to pop a
 * wall-flush spawn if it were left to Rapier's own contact solve instead of placed with zero
 * protrusion up front: near the floor, where the wheel box (`BB_SIDE_ROLLER_H` = 2 in tall) sits,
 * an embedded box escapes whichever of "push it out sideways" (1.9 in) or "push it out through
 * the floor" (its OWN height, 2.5 in) is shorter, and either pick is a POP the driver did not
 * cause. At the OLD 2.65-in reach the floor pick won and cancelled dead against the real floor
 * collider (measured: a `back`-mount `siderollers` build on the REAR-WALL anchor, 300 ticks / 5 s,
 * ZERO drift on every axis — not slow, exactly frozen, because the two opposing pushes were equal
 * and opposite every tick); at 1.9 in the sideways escape is now the shorter of the two, but the
 * fix does not depend on which axis wins — placing the anchor with zero protrusion in the first
 * place (below) avoids the SAT pick entirely, in either direction. `ramp` is FOLDED at spawn —
 * `RobotState.bbRampOut` is absent, reading false, with
 * no deploy in flight, so `bbRampSettled` is false and `chassis3dReachShapes` gives it no
 * collider at all — so this is zero for every archetype but `siderollers` today, and it stays
 * here (not a `siderollers`-only signature) for the day a fourth archetype ships its own
 * always-solid hardware.
 *
 * PLAIN NUMBERS ONLY, deliberately. `spawn.ts` builds every world, 2D and 3D alike, and it is a
 * MAIN-BUNDLE file — it may not import `sim3d/bodies.ts`'s `chassis3dReachShapes` (the lazy-chunk
 * boundary `docs/area/biobuzz.md` documents: dragging the Rapier3D physics chunk into the main
 * bundle is exactly the cost that split exists to avoid). This is that geometry's one scalar,
 * reachable with no Rapier and no `sim3d/` import at all.
 */
export function bbArchetypeWallExtra(kind: BbIntakeKind): number {
  return kind === 'siderollers' ? BB_SIDE_ROLLER_PROTRUDE : 0;
}

/**
 * THE BOX TUBE — a vertical two-stage box-tube slide at the frame rail, on a small pivot, with a
 * wrist and a claw on top (owner, 2026-09-22: "Offset boxtube still looks extremely weird").
 *
 * WHAT THE REAL PART IS. The OFFSET™ Box Tube Slide Kit is a "2-stage" slide: THREE nested
 * aluminium tubes of about the same length (300 mm outer stage, 885 mm extended — published),
 * running on bearing blocks at each stage's mouth and pulled out by a string (or belt) spool at
 * the base. On an FTC robot that has to put an element into a goal 21 in up, it stands at the
 * robot's edge, rises, and a wrist-mounted claw at the top swings the element over the goal.
 *
 * WHAT IT REPLACED, AND WHY EACH PIECE WAS WRONG (measured off the shipped build, Pollinator):
 *  1. The arm did not deploy where drivers use it. A robot flush on a FLOWER foot got 19% of its
 *     extension at 17° of pitch and stayed there: the deploy cap's bisection assumed its safe set
 *     was an interval and the parked pose itself failed the radius test by rounding. 3,550 of
 *     28,928 in-reach poses stalled; the RENDER lane's tip check read the uncapped solve, so it
 *     never saw the drawn arm.
 *  2. The outer tube (a flat "cradle") stayed on the deck while the four inner stages rotated
 *     out of its mouth — telescoping tubes that bend 90° at a joint. Their tails swung below the
 *     pivot, into the deck.
 *  3. Five sections tapering 1.5 → 0.5 in read as a car antenna, with nothing at the tip.
 *  4. Stowed, the cradle ran 2.3 in into a centre turret's ring bearing and base plate, and its
 *     pivot sat inside the end bar the front/back marks added, so from behind it was invisible.
 *  5. Nothing drove the pivot or the stages, and the tip parked BESIDE the flower, not over it.
 *
 * THE MECHANISM NOW, in the TOWER FRAME (`bbBoxTubeFrame`: u outward toward the placement point,
 * v = u turned +90°, z up, origin on the pivot axle under the mast):
 *  · two PIVOT PLATES flank the base tube and carry the axle; outside one plate is the pivot
 *    PULLEY (its belt runs down through the deck to a motor under it), outside the other the
 *    string SPOOL. The whole slide leans about the axle — only a few degrees, `bbBoxTubePose`;
 *  · three tubes `BB_BOX_TUBE_SECTIONS`, nested, each `sectionLen` long, sliding along the axis;
 *  · on top of the last stage a WRIST (a servo block, kept level) and a CLAW on a short arm: it
 *    hangs folded beside the mast when stowed and swings out level over the FLOWER's top bore
 *    when deployed, with the claw centre on the bore to 1e-9.
 * The pose is solved per frame against the flower `bbFlowerInReach` names, and the sim is not
 * involved: placement is still a proximity action. The stowed tower IS a collider
 * (`bbBoxTubeEnvelopes`), like a turret head, because it stands 7 in above the deck.
 */
export const BB_BOX_TUBE_SECTIONS = [1.2, 0.95, 0.7] as const;
/** wall (in): 1.2 − 2 × 0.125 = 0.95 is the next section's outside, so the nest closes. */
export const BB_BOX_TUBE_WALL = 0.125;
/** how much of each moving stage stays inside the one outboard of it at full extension (in):
 * one bearing block. APPROX. */
export const BB_BOX_TUBE_STAGE_OVERLAP = 0.9;
/** how far the base tube runs below the pivot axle (in) — the axle goes through its foot. */
export const BB_BOX_TUBE_BASE_BELOW = 0.45;
/** the mast axis inside the frame rail, per axis the mount touches (in): an EDGE mount's 0.7
 * leaves the 1.2 base tube 0.1 inside the rail; a CORNER mount's tower is turned 45° and needs
 * 1.25 for its plates and spool to stay inside both rails. */
export const BB_BOX_TUBE_INSET = 0.7;
export const BB_BOX_TUBE_CORNER_INSET = 1.25;
/** the pivot bracket (in): plate thickness, the gap between the base tube and a plate, the
 * plates' extent along u, and how far above the axle they stop. APPROX, sized as FTC plate. */
export const BB_BOX_TUBE_PLATE_T = 0.125;
export const BB_BOX_TUBE_PLATE_GAP = 0.06;
export const BB_BOX_TUBE_PLATE_U0 = -0.85;
export const BB_BOX_TUBE_PLATE_U1 = 0.55;
export const BB_BOX_TUBE_PLATE_ABOVE = 0.55;
/** the pivot pulley and the string spool, one outside each plate (in). */
export const BB_BOX_TUBE_DRUM_R = 0.5;
export const BB_BOX_TUBE_DRUM_T = 0.25;
/** the last stage's top face stops this far above the FLOWER's top plate (in). */
export const BB_BOX_TUBE_TIP_CLEAR = 0.6;
/** the wrist (in): hinge height above the tip, the servo block's top above the tip, and the
 * hinge's offset from the mast axis — which is what lets the folded claw hang BESIDE the mast. */
export const BB_BOX_TUBE_WRIST_H = 0.3;
export const BB_BOX_TUBE_WRIST_TOP = 0.45;
export const BB_BOX_TUBE_WRIST_E = 0.85;
/** the servo block's half-width on the mast axis, how far out the yoke that carries the hinge
 * reaches, and the folded claw's half-width across its own hanging direction (in) */
export const BB_BOX_TUBE_WRIST_HALF = 0.45;
export const BB_BOX_TUBE_YOKE_OUT = 1.0;
export const BB_BOX_TUBE_CLAW_HALF = 0.4;
/** how far a bearing block stands proud of the tube it caps (in) */
export const BB_BOX_TUBE_COLLAR = 0.05;
/** mast axis → claw centre, horizontal, when deployed (in). It has to be at least the flower's
 * widest top-plate radius (`BB_FLOWER_OUTER_MAX` 3.113) plus half the top stage plus air, or the
 * mast itself passes through the plate: 3.113 + 0.35 + 0.34. */
export const BB_BOX_TUBE_CLAW_REACH = 3.8;
/** the claw arm's section (thickness in the swing plane, width along the hinge axis), where
 * the palm sits short of the claw centre, and the two jaws (in, rad). The jaws open to ±1.39 —
 * a POLLEN at its equator — so they stay inside the 2.086-in bore radius over the flower. */
export const BB_BOX_TUBE_ARM_T = 0.25;
export const BB_BOX_TUBE_ARM_W = 0.5;
export const BB_BOX_TUBE_PALM_BACK = 1.0;
export const BB_BOX_TUBE_JAW_L = 1.7;
export const BB_BOX_TUBE_JAW_ROOT = 0.3;
export const BB_BOX_TUBE_JAW_T = 0.12;
export const BB_BOX_TUBE_JAW_H = 0.3;
export const BB_BOX_TUBE_JAW_OPEN = (40 * Math.PI) / 180;
/** clear air the drawn mechanism keeps from the flower's real solid over the whole deploy, as
 * the RENDER lane binds it (in). Measured 0.394 at the shipped constants. */
export const BB_BOX_TUBE_FLOWER_GAP = 0.25;

/** seconds for the whole deploy, RENDERER only (no sim travel). APPROX. It was 0.12 (owner:
 * "way too quickly … in a violent way"), then 0.40 for a pitch-and-extend; the sequence now also
 * swings and turns a claw, so 0.45. Every phase is a smoothstep (`bbBoxTubePhases`). */
export const BB_BOX_TUBE_EXTEND_S = 0.45;
/** retraction as a fraction of the deploy time. APPROX. */
export const BB_BOX_TUBE_RETRACT_F = 0.8;
/** how fast the pose TARGET may move once the arm is out (rad/s, in/s), so a change of target
 * flower sweeps instead of snapping. RENDER-only, APPROX. */
export const BB_BOX_TUBE_SLEW = 3.0;
export const BB_BOX_TUBE_EXT_SLEW = 60;

/** the tower's frame in the robot frame. `s` is where the folded claw hangs (a unit vector along
 * a rail, so it stays inside the frame at a corner too). */
export interface BbBoxTubeFrame {
  outer: { x: number; y: number };
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  sx: number;
  sy: number;
  corner: boolean;
  /** horizontal distance from the mast axis to the placement point */
  placeDist: number;
}

/**
 * THE TOWER'S FRAME for a mount. The mast axis is inset from the rail per axis the mount
 * touches; `u` aims at the placement point `place` (`bbPlacePointLocal`), which is `MOUNT_DIR`
 * on an edge and close to the diagonal at a corner.
 */
export function bbBoxTubeFrame(
  spec: Pick<RobotSpec, 'length' | 'width'>,
  mount: BbMountPos,
  place: { x: number; y: number } | null,
): BbBoxTubeFrame {
  const pos: BbMountPos = mount === 'center' ? 'front' : mount;
  const o = mountOrigin(spec, pos);
  const d = MOUNT_DIR[pos];
  const corner = Math.abs(d.x) > 1e-9 && Math.abs(d.y) > 1e-9;
  const ins = corner ? BB_BOX_TUBE_CORNER_INSET : BB_BOX_TUBE_INSET;
  const outer = { x: o.x - Math.sign(d.x) * ins, y: o.y - Math.sign(d.y) * ins };
  let ux = d.x;
  let uy = d.y;
  let placeDist = 0;
  if (place) {
    placeDist = hyp(place.x - outer.x, place.y - outer.y);
    if (placeDist > 1e-6) {
      ux = (place.x - outer.x) / placeDist;
      uy = (place.y - outer.y) / placeDist;
    }
  }
  // the folded claw hangs along +v on an edge; at a corner, along the front/back rail toward the
  // robot's centre line (either v would leave the frame within an inch)
  const sx = corner ? 0 : -uy;
  const sy = corner ? -Math.sign(d.y) : ux;
  return { outer, ux, uy, vx: -uy, vy: ux, sx, sy, corner, placeDist };
}

/**
 * THE STAGE TABLE. The tip's height is fixed (`BB_FLOWER_TOP_Z + BB_BOX_TUBE_TIP_CLEAR`); how far
 * it sits along `u` from the pivot is `bbBoxTubePose`'s `s`, and over the in-reach disc (the ring
 * within `BB_PLACE_TOL` of the placement point, `reach` out along `u`) that is between
 * `reach − TOL − CLAW_REACH` and `reach + TOL − √(CLAW_REACH² − TOL²)`. The longest arm those ask
 * for sizes three equal tubes: tip = n·len − BASE_BELOW − (n − 1)·overlap.
 */
export function bbBoxTubeStages(reach: number): {
  sectionLen: number;
  travel: number;
  moving: number;
  full: number;
  /** the retracted tip's distance from the pivot, and the stowed tower's top above the tiles */
  retracted: number;
  stowTop: number;
} {
  const n = BB_BOX_TUBE_SECTIONS.length;
  const tol = BB_PLACE_TOL;
  const lw = BB_BOX_TUBE_CLAW_REACH;
  const sHi = reach + tol - Math.sqrt(lw * lw - tol * tol);
  const sLo = reach - tol - lw;
  const dz = BB_FLOWER_TOP_Z + BB_BOX_TUBE_TIP_CLEAR - BB_BOX_TUBE_Z;
  const lenMax = hyp(Math.max(Math.abs(sHi), Math.abs(sLo)), dz);
  const sectionLen = (lenMax + BB_BOX_TUBE_BASE_BELOW + (n - 1) * BB_BOX_TUBE_STAGE_OVERLAP) / n;
  const travel = sectionLen - BB_BOX_TUBE_STAGE_OVERLAP;
  const retracted = sectionLen - BB_BOX_TUBE_BASE_BELOW;
  return {
    sectionLen,
    travel,
    moving: n - 1,
    full: (n - 1) * travel,
    retracted,
    stowTop: BB_BOX_TUBE_Z + retracted + BB_BOX_TUBE_WRIST_TOP,
  };
}

/**
 * THE DEPLOYED POSE for one target — the ONE solve the 3D arm, the 2D sprite and the RENDER lane
 * all read. Everything is in the ROBOT frame: `bore` is the flower's top-bore centre, `nrm` its
 * inward wall normal, `zOff` the chassis' own height off the tiles.
 *
 * The claw centre has to land on the bore at `CLAW_REACH` from the mast axis, so the tip sits at
 * `s = a − √(CLAW_REACH² − b²)` along `u` (a, b: the bore in the tower frame) and the mast leans
 * to put it there — back over its own robot when the robot is flush, out when it is not.
 * `psi` is the claw's bearing; `psiSwing` is the plane it swings up in, 90° off the bore line on
 * the FIELD side (`nrm`), so the last move is a level turn in from the field side — never a
 * swing down through the top plate, and never past the flower's wall-side backstop.
 */
export function bbBoxTubePose(
  frame: BbBoxTubeFrame,
  stages: { sectionLen: number; travel: number; moving: number; retracted: number },
  bore: { x: number; y: number },
  nrm: { x: number; y: number },
  zOff = 0,
): { a: number; b: number; s: number; lean: number; ext: number; psi: number; psiSwing: number; claw: { x: number; y: number } } {
  const dx = bore.x - frame.outer.x;
  const dy = bore.y - frame.outer.y;
  const a = dx * frame.ux + dy * frame.uy;
  const b = dx * frame.vx + dy * frame.vy;
  const lw = BB_BOX_TUBE_CLAW_REACH;
  const sWant = a - Math.sqrt(Math.max(0, lw * lw - b * b));
  const dz = BB_FLOWER_TOP_Z + BB_BOX_TUBE_TIP_CLEAR - (BB_BOX_TUBE_Z + zOff);
  const lean = datan2(dz, sWant);
  // CLAMPED to what the stages have, so no stage ever leaves its parent — a pose the sizing did
  // not anticipate falls short instead of coming apart
  const ext = clamp((hyp(sWant, dz) - stages.retracted) / stages.moving, 0, stages.travel);
  const s = (stages.retracted + stages.moving * ext) * dcos(lean);
  const tx = frame.outer.x + s * frame.ux;
  const ty = frame.outer.y + s * frame.uy;
  const psi = datan2(bore.y - ty, bore.x - tx);
  const side = -dsin(psi) * nrm.x + dcos(psi) * nrm.y >= 0 ? 1 : -1;
  return {
    a,
    b,
    s,
    lean,
    ext,
    psi,
    psiSwing: psi + side * (Math.PI / 2),
    claw: { x: tx + lw * dcos(psi), y: ty + lw * dsin(psi) },
  };
}

/**
 * THE DEPLOY SEQUENCE, as one ease `e` in [0, 1] (the renderer's, 0.45 s). Retraction runs the
 * same map backwards. Each phase is a smoothstep, so every joint starts and stops at zero rate:
 *   lean     0.00–0.30   the slide tilts off vertical to its pose
 *   turn     0.05–0.25   the folded claw turns, still hanging, to its swing plane
 *   extend   0.10–0.65   both stages run out
 *   swing    0.65–0.82   the claw swings up level, and the jaws open
 *   reach    0.82–1.00   a level turn over the bore
 * The order is MEASURED against the flower solid: swinging toward the bore dips the arm into the
 * top plate on every pose, and turning a hanging claw while it passes the plate clips its corner.
 */
export function bbBoxTubePhases(e: number): { lean: number; turn: number; extend: number; swing: number; reach: number } {
  const sm = (x: number): number => {
    const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
    return t * t * (3 - 2 * t);
  };
  return {
    lean: sm(e / 0.3),
    turn: sm((e - 0.05) / 0.2),
    extend: sm((e - 0.1) / 0.55),
    swing: sm((e - 0.65) / 0.17),
    reach: sm((e - 0.82) / 0.18),
  };
}

/** the joint values at ease `e` for a solved pose: lean (from horizontal along u), per-stage
 * extension, claw bearing (robot frame), swing (0 hanging, π/2 level) and jaw opening. */
export function bbBoxTubeJoints(
  frame: BbBoxTubeFrame,
  pose: { lean: number; ext: number; psi: number; psiSwing: number },
  e: number,
): { lean: number; ext: number; psi: number; swing: number; jaw: number } {
  const q = bbBoxTubePhases(e);
  const stow = datan2(frame.sy, frame.sx);
  const toSwing = wrapAngle(pose.psiSwing - stow);
  const inward = wrapAngle(pose.psi - pose.psiSwing);
  return {
    lean: Math.PI / 2 + q.lean * (pose.lean - Math.PI / 2),
    ext: q.extend * pose.ext,
    psi: stow + q.turn * toSwing + q.reach * inward,
    swing: q.swing * (Math.PI / 2),
    jaw: q.swing * BB_BOX_TUBE_JAW_OPEN,
  };
}

/** a rectangle in the TOWER frame: [u0, u1] × [v0, v1] × [z0, z1], z relative to the axle. */
export interface BbTowerBox {
  what: 'mast' | 'plate' | 'drum' | 'claw';
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  z0: number;
  z1: number;
}

/**
 * THE STOWED TOWER, as boxes in its own frame — what the 2D sprite fills, what the 3D meshes are
 * built to, and what the collider is the bounding box of. The claw box is the folded claw
 * hanging along `s`, which the caller turns into the tower frame (it is along a RAIL, not
 * necessarily along v).
 */
export function bbBoxTubeStowedBoxes(frame: BbBoxTubeFrame, stages: { retracted: number }): BbTowerBox[] {
  const h0 = BB_BOX_TUBE_SECTIONS[0] / 2;
  const deck = BB_DECK_Z - BB_BOX_TUBE_Z;
  const pIn = h0 + BB_BOX_TUBE_PLATE_GAP;
  const pOut = pIn + BB_BOX_TUBE_PLATE_T;
  const top = BB_BOX_TUBE_PLATE_ABOVE;
  const out: BbTowerBox[] = [
    // the base tube and the bearing block round its mouth
    {
      what: 'mast',
      u0: -h0 - BB_BOX_TUBE_COLLAR,
      u1: h0 + BB_BOX_TUBE_COLLAR,
      v0: -h0 - BB_BOX_TUBE_COLLAR,
      v1: h0 + BB_BOX_TUBE_COLLAR,
      z0: -BB_BOX_TUBE_BASE_BELOW,
      z1: stages.retracted + BB_BOX_TUBE_WRIST_TOP,
    },
  ];
  for (const sg of [1, -1] as const) {
    const a = sg * pIn;
    const b = sg * pOut;
    out.push({ what: 'plate', u0: BB_BOX_TUBE_PLATE_U0, u1: BB_BOX_TUBE_PLATE_U1, v0: Math.min(a, b), v1: Math.max(a, b), z0: deck, z1: top });
    const c = sg * (pOut + BB_BOX_TUBE_DRUM_T);
    out.push({ what: 'drum', u0: -BB_BOX_TUBE_DRUM_R, u1: BB_BOX_TUBE_DRUM_R, v0: Math.min(b, c), v1: Math.max(b, c), z0: -BB_BOX_TUBE_DRUM_R, z1: BB_BOX_TUBE_DRUM_R });
  }
  // the folded claw: arm + closed jaws hanging from the hinge, `WRIST_E` out along s
  const hinge = stages.retracted + BB_BOX_TUBE_WRIST_H;
  const hangLen = BB_BOX_TUBE_CLAW_REACH - BB_BOX_TUBE_WRIST_E - BB_BOX_TUBE_PALM_BACK + BB_BOX_TUBE_JAW_L;
  const su = frame.sx * frame.ux + frame.sy * frame.uy;
  const sv = frame.sx * frame.vx + frame.sy * frame.vy;
  // in the hanging claw's own frame: along s from the servo block out past the arm and the jaws,
  // across it the yoke's cheeks and the closed jaws
  const tb = BB_BOX_TUBE_CLAW_HALF;
  const out1 = Math.max(BB_BOX_TUBE_YOKE_OUT, BB_BOX_TUBE_WRIST_E + Math.max(BB_BOX_TUBE_ARM_T, BB_BOX_TUBE_JAW_H) / 2);
  const corners: [number, number][] = [];
  for (const da of [BB_BOX_TUBE_WRIST_HALF, out1]) for (const db of [-tb, tb]) corners.push([da * su - db * sv, da * sv + db * su]);
  out.push({
    what: 'claw',
    u0: Math.min(...corners.map((c) => c[0])),
    u1: Math.max(...corners.map((c) => c[0])),
    v0: Math.min(...corners.map((c) => c[1])),
    v1: Math.max(...corners.map((c) => c[1])),
    z0: hinge - hangLen,
    z1: stages.retracted + BB_BOX_TUBE_WRIST_TOP,
  });
  return out;
}

/** a tower box turned into the ROBOT frame, as its axis-aligned bounding rectangle, with z on
 * the tiles. */
export function bbTowerBoxRobot(frame: BbBoxTubeFrame, b: BbTowerBox): { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const u of [b.u0, b.u1]) {
    for (const v of [b.v0, b.v1]) {
      xs.push(frame.outer.x + u * frame.ux + v * frame.vx);
      ys.push(frame.outer.y + u * frame.uy + v * frame.vy);
    }
  }
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
    z0: BB_BOX_TUBE_Z + b.z0,
    z1: BB_BOX_TUBE_Z + b.z1,
  };
}

/** the placement point, the same arithmetic as `bbPlacePointLocal` (`robot.ts`), which this file
 * cannot import (it imports this one). The ROBOT lane pins the two equal on every build. */
export function bbLiftPlaceLocal(spec: RobotSpec): { x: number; y: number } | null {
  const lift = bbLiftOf(spec);
  if (!lift) return null;
  const d = MOUNT_DIR[lift.mount];
  const reach = bbIntakeReach(spec);
  const im = bbIntakeMountOf(spec);
  const front = spec.length / 2 + (im === 'front' || im === 'frontback' ? reach : 0);
  const rear = spec.length / 2 + (im === 'back' || im === 'frontback' ? reach : 0);
  const half = spec.width / 2 + (im === 'side' ? reach : 0);
  const o = mountOrigin(spec, lift.mount);
  const x = d.x > 0 ? front : d.x < 0 ? -rear : o.x;
  const y = d.y > 0 ? half : d.y < 0 ? -half : o.y;
  return { x: x + d.x * BB_PLACE_REACH, y: y + d.y * BB_PLACE_REACH };
}

/**
 * THE STOWED TOWER AS COLLIDERS — two boxes, like a dumper's: the BASE (plates, pulley, spool,
 * the foot of the mast) from the deck to the plate tops, and the COLUMN (the mast and the folded
 * claw beside it) from there to the wrist. Each is the robot-frame bounding box of the drawn
 * boxes it covers; at a corner the tower is turned 45° and the box is generous by the difference.
 * The DEPLOYED part above the stowed top is a drawn part outside the collider — it only exists
 * while the robot is parked on a flower, the dumper mid-throw's bargain.
 */
export function bbBoxTubeEnvelopes(spec: RobotSpec, heightIn: number): BbMechEnvelope[] {
  const lift = bbLiftOf(spec);
  if (!lift) return [];
  const frame = bbBoxTubeFrame(spec, lift.mount, bbLiftPlaceLocal(spec));
  const stages = bbBoxTubeStages(frame.placeDist);
  const boxes = bbBoxTubeStowedBoxes(frame, stages).map((b) => bbTowerBoxRobot(frame, b));
  const plateTop = BB_BOX_TUBE_Z + BB_BOX_TUBE_PLATE_ABOVE;
  const union = (list: typeof boxes): { cx: number; cy: number; hx: number; hy: number } => {
    const x0 = Math.min(...list.map((b) => b.x0));
    const x1 = Math.max(...list.map((b) => b.x1));
    const y0 = Math.min(...list.map((b) => b.y0));
    const y1 = Math.max(...list.map((b) => b.y1));
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 };
  };
  const base = boxes.filter((b) => b.z0 < plateTop - 1e-9);
  const column = boxes.filter((b) => b.z1 > plateTop + 1e-9);
  const top = Math.min(heightIn, Math.max(...column.map((b) => b.z1)));
  // ⚠️ BOTH ARE `narrow`: a POLLEN dropped on the stowed tower BALANCED on its 1.3-in top at
  // z 11.68 for as long as a match lasts, as a square box it is a shelf to `groundRoll3d`
  return [
    { what: 'liftBase', ...union(base), top: Math.min(heightIn, plateTop), narrow: true },
    { what: 'liftColumn', ...union(column), bottom: plateTop, top, narrow: true },
  ];
}
/**
 * A DUMPER'S RANGE (owner, 2026-09-13) — how far from the cell it is dumping into a dumper can
 * throw from, measured horizontally from each element's release point on the dumper's edge to
 * the cell centre (in). APPROX all three.
 *
 * A DUMP IS A LOB, NOT A FIXED-HOOD SHOT. Each element is thrown to peak `BB_DUMP_APEX_ABOVE`
 * over the cell's aim height and drop onto it (`bbLobThrow`, `robot.ts`), so it arrives
 * DESCENDING — which `hiveAccepts` requires — from any distance, and the minimum is geometry
 * alone: `BB_DUMP_MIN_DIST` is only the floor below which a throw has no direction. The fixed hood
 * this replaced made a dumper stand far off (23–71 in at the default 75°, since a flat-ish arc
 * only descends past its apex) and also reach far; the owner ruled both wrong, so the MAXIMUM is
 * a strict cap rather than whatever `BB_LAUNCH_SPEED_MAX` happens to allow (~108 in).
 */
export const BB_DUMP_MIN_DIST = 1;
export const BB_DUMP_MAX_DIST = 36;
export const BB_DUMP_APEX_ABOVE = 4;

/**
 * The hood elevation a DUMPER used to be built at, in DEGREES above level.
 *
 * ⚠️ NO LONGER READ BY THE SIM (owner, 2026-09-13). A dump is solved as a lob for its distance
 * (`BB_DUMP_MAX_DIST` above), so the builder offers no Hood dial and no label prints one. The
 * field stays on `BbLauncherSpec` and the coercer still clamps it to this range, so saved robots,
 * presets and replays keep round-tripping unchanged.
 */
export const BB_HOOD_DEFAULT_DEG = 75;
export const BB_HOOD_MIN_DEG = 70;
export const BB_HOOD_MAX_DEG = 85;

/** how long a DUMPER takes to re-arm after a dump (s). APPROX — a tray swinging back down. It is
 * what stops a held fire button re-dumping on every capture. */
export const BB_DUMP_RELOAD_S = 0.75;

/**
 * ⚠️ **A DUMPER IS A CATAPULT: ONE FLING, THE WHOLE BUCKET** (owner, 2026-09-19: "a dumper should
 * not shoot one at a time. It holds four in a small 'hopper' and it would fling it like a
 * catapult"). This is how many seats the bucket has.
 *
 * ── WHAT IT REPLACED, AND WHY THE REPLACEMENT IS A DIFFERENT MACHINE ─────────
 * 3D used to POUR — `BbShot.perDump = 1` and a `BB_DUMP_STAGGER_S` of 0.3 s between elements —
 * because `bbDumpSolution` aims every element of a dump from its OWN release point at the SAME
 * cell-centre point, so four real spheres released together converge and knock each other off the
 * arc (measured 3/28 on the tutorial grid simultaneous against 20/28 staggered). The stagger
 * treated the symptom. A CATAPULT does not converge: one arm, one velocity, four seats, so the
 * cluster flies on PARALLEL arcs and keeps its bucket footprint all the way into the opening —
 * which is what `bbDumpCluster` (`robot.ts`) builds, and why the stagger is gone.
 *
 * FOUR because the opening is 20.14 x 10.18 in (`BB_CELL_OPEN`) and a 2x2 bucket at
 * `BB_DUMP_SEAT_PITCH` presents a 4 x 4 in square of centres — 5.66 in across its diagonal,
 * against the 10.18 in short axis, so the cluster fits the narrow way round at ANY approach
 * bearing with 2.4 in of clear rim on a NECTAR's 1.8-in radius. A row of four does NOT: it is
 * 12 + 3.6 = 15.6 in long and only fits the 20.14 axis, i.e. only on one bearing.
 */
export const BB_DUMP_BUCKET = 4;

/**
 * the centre-to-centre spacing of the bucket's seats (in) — see `BB_DUMP_BUCKET`.
 *
 * It has to clear the biggest element the bucket can hold (a NECTAR, `BB_NECTAR_R` 1.8, so 3.6 in
 * of diameter) with room for the birth clearance not to see an overlap, and it has to keep the
 * 2x2's diagonal inside the cell opening's SHORT axis. 4.0 in does both: a 0.4-in gap between two
 * NECTAR, a 1.2-in gap between two POLLEN, and a 5.66-in diagonal inside 10.18. APPROX.
 */
export const BB_DUMP_SEAT_PITCH = 4;


/** the most BEATS of the accumulated cadence clock one tick may serve (`bbLaunch`). With
 * `BB_FIRE_INTERVAL` above a tick it is normally 1; this only bounds a pathological catch-up. A
 * DOUBLE turret releases up to one element PER EXIT per beat, so the element bound is twice this
 * for that build — and the hopper cap is well under either. APPROX. */
export const BB_FIRE_BURST_MAX = 6;

/**
 * ⚠️ THE HOOD IS THE ONLY ANGLE IN THIS GAME MEASURED IN DEGREES, AND ONLY ON THE SPEC.
 *
 * The sim is radians throughout — `dsin`/`dcos`/`datan2` are DETERMINISTIC trig, not DEGREE
 * trig (the `d` has burned people), `BB_TURRET_SLEW` is rad/s and `BB_AIM_TOL` is rad. But a
 * hood angle is a number a player reads off a slider, and "35°" is what that player means;
 * Chain Reaction makes the same call for `catapultYaw` ("in DEGREES relative to chassis
 * forward"). So it is stored in degrees and converted HERE, once, at the boundary — never
 * passed to a trig function raw.
 */
export const BB_DEG = Math.PI / 180;

/** how fast a TURRET's pitch axis slews, in RADIANS per second (~92 deg/s). APPROX, and deliberately
 * slower than the yaw slew: elevation carries the barrel's weight where yaw turns a ring. The
 * HIVE's up-CELL is the only thing a turret aims at (launched elements never enter a FLOWER),
 * and the elevation that cell needs swings widely with range — a lob from beside the HIVE
 * against a flat shot from the far corner at a 53.5–65.6 in opening — so a turret that
 * re-elevated instantly would make close and far shots feel identical. Driving between them is
 * what the pitch axis exists to make cost something. */
export const BB_TURRET_PITCH_SLEW = 1.6;
/** the pitch envelope a turret can actually reach, in RADIANS — level to ~80 deg. A barrel
 * cannot depress below level (it would fire into the robot's own deck) and cannot go fully
 * vertical (the feed path is in the way). APPROX both ends. */
export const BB_TURRET_PITCH_MIN = 0;
export const BB_TURRET_PITCH_MAX = 80 * BB_DEG;

/**
 * THE ELEVATION A TURRET SPAWNS AT, and the one the 3D builder preview draws (`renderRobots.ts`).
 *
 * It used to be `BB_TURRET_PITCH_MIN`: a LEVEL shot, which puts the hood's lip straight over the
 * wheel and is the TALLEST pose the hood has. Nothing aims there. A turret re-solves at the HIVE
 * cell every tick (`bbTurretSolution`), and a 53.5–65.6-in cell cannot be reached level. MEASURED
 * over a 6-in field grid × four headings, 2,116 poses per turret on a double turret: min 58.6°,
 * p25 65.0°, **p50 68.7°**, p75 74.4°, max 80.0° (the stop), the same for both exits. So a robot
 * spawns at the median (owner, 2026-09-24: "The hood is WAY too high. It never goes that high"),
 * and the first aim tick has ~10° to cover rather than ~69°.
 */
export const BB_TURRET_PITCH_REST = 69 * BB_DEG;

/**
 * EVERY LAUNCHER'S TOP SPEED (in/s) — a turret's flywheel ceiling AND a dumper's, and the reason
 * a launcher's range is a number rather than an infinity. (It was `BB_TURRET_SPEED_MAX` while
 * only a turret solved its speed; the dumper solves its own per shot now too, so it is shared.)
 *
 * A launcher solves its own arc (`bbTurretSolution`, `bbHoodSpeed`), so unless the speed is
 * bounded somewhere it reaches every opening on the field from everywhere and the pitch envelope
 * and the hood become decoration. A dump whose hood has no solution fires AT this cap.
 * SIZED SO IT IS NOT NORMALLY WHAT BITES: the longest legal shot at a HIVE is a robot in the
 * far corner firing at the opposite up-CELL. RE-MEASURED 2026-09-19 through the real solve, on
 * the 2-in field grid with the robot centre 9 in off the wall: the worst pose is (−61.67,
 * −61.67) at **256.37 in/s**, leaving **3.63 in/s of headroom**. It was 253.26 (6.74 of
 * headroom) while the muzzle was a flat 10 in; the hood-following release sits ~2.1 in lower at
 * the elevations a HIVE shot uses, and a lower release costs a little speed. NOTHING on the
 * field is speed-capped either way — the cap was not raised and must not be, since the same
 * change cut PITCH-capped poses from 255 to 211 and added 45 scoreable cells. The thing that
 * makes a turret miss is still the SLEW (aim is a physical state) and not the range. A target further or higher than the HIVE would fall short, which is
 * a miss the driver can see and drive out of rather than a silent skip.
 *
 * APPROX, like every launcher number here — see the risks in `docs/biobuzz/plan-mechanisms.md`.
 */
export const BB_LAUNCH_SPEED_MAX = 260;

/** the muzzle speed a launcher fires at when there is NO target to solve against (in/s) — a
 * turret or dumper with nothing on its open side still fires, into nothing in particular.
 * APPROX: the old drum's tuned speed, kept as a neutral number. */
export const BB_LAUNCH_SPEED_DEFAULT = 175;

/** how far a turretless launcher's plates reach past the flywheel (in). APPROX. (The GAP that
 * used to sit beside it is `BbHeadDims.plateGap` now — it is per HEAD, because a NECTAR channel
 * is not a POLLEN channel. `BB_LAUNCH_PLATE_GAP` below is the POLLEN one, kept for the 2D
 * sprite.) */
export const BB_LAUNCH_PLATE_OVERHANG = 1.2;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — THE TURRET'S DIMENSION CHAIN (the hooded flywheel)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **THIS CHAIN USED TO LIVE IN `scene/renderRobots.ts`, PRIVATELY, AND THAT IS WHY IT TOOK
 * SIX PASSES.** (owner report 2026-09-19, items a–e.)
 *
 * The renderer owned the flywheel radius, the hood radius, the plate profile and the muzzle
 * height; the sim owned `BB_LAUNCH_Z0`. Two numbers, two owners, and every round of feedback
 * moved one of them to answer the last complaint — so the picture and the physics agreed at one
 * pitch and nowhere else, and the next look found the next disagreement. The chain is here now,
 * `bbMuzzleLocal` (`robot.ts`) is the ONE function that turns it into a release, and BOTH the
 * sim and the 3D scene read that function. Same rule the shot path already follows: ONE
 * PREDICTOR, TWO DRAWINGS.
 *
 * Every length is in INCHES, every angle in RADIANS. There are TWO frames and the difference
 * matters at every line below:
 *
 *  · the **TURRET frame** — origin on the turret's ROTATION AXIS (the slew ring's bore, which is
 *    where the feed comes up), +x the shot direction at rest, +z up. `turretLocal` puts this on
 *    the chassis and `bbMuzzleLocal` answers in it.
 *  · the **AXLE frame** — the same axes, origin moved forward to the FLYWHEEL AXLE by
 *    `BbHeadDims.axleX`. θ is measured CCW from +x, so the exit is at θ = 90° (straight up over
 *    the wheel) and the feed pinch at θ = 180° (dead behind it). Every (θ, r) here is this one.
 *
 * ⚠️ **THE TWO FRAMES USED TO BE ONE, AND THE OWNER'S SECOND ITEM OF 2026-09-19 IS WHAT
 * SEPARATED THEM:** "the flywheel should come forward more so that the location where the balls
 * contact the flywheel initially as it comes up is roughly in the center of the turret". A real
 * hooded shooter is fed THROUGH the ring bearing: the element rises vertically up the rotation
 * axis, meets the wheel at its back, and is pinched between wheel and hood. That puts the
 * element's centre at the pinch on the turret axis, and the element's centre at the pinch is
 * exactly `pathR` from the axle — so `axleX = pathR`, and the whole head moved forward by it.
 */

/**
 * FLYWHEEL DIAMETER, IN MILLIMETRES — **72 mm, MEASURED HARDWARE** (owner, 2026-09-19).
 *
 * Recorded as the millimetres it actually is and converted here, once. A 72 mm wheel is
 * 2.8346 in, and writing that as a decimal literal would lose the only thing about it that is
 * not a judgement call. ONE wheel drives both heads: a bigger element does not want a bigger
 * flywheel, it wants a bigger hood.
 */
export const BB_FLYWHEEL_D_MM = 72;
export const BB_FLYWHEEL_R = BB_FLYWHEEL_D_MM / 2 / 25.4;

/** how much an element is squeezed between the wheel and the hood (in). APPROX — a compliant
 * wheel against a polycarb hood; it is what makes a shooter grip rather than jam. */
export const BB_HOOD_COMPRESSION = 0.3;

/** hood wall thickness (in). It is what makes the hood stand PROUD of the side plates: the
 * plates' outer arc is exactly the head's own `hoodR` and the hood occupies `hoodR … +BB_HOOD_T`,
 * so the hood is the outermost part BY CONSTRUCTION at every pitch, never by a tuned offset. */
export const BB_HOOD_T = 0.28;

/**
 * how far round the wheel the hood wraps, from the exit lip BACKWARD (rad ≈ 31.9°).
 *
 * ⚠️ **WAS 1.05 (60°), AND IT SHRANK BECAUSE THE HOOD MOVES NOW.** A hood that pivots on the
 * axle carries its own feed mouth round with it: at `BB_TURRET_PITCH_MAX` the mouth has gone 80°
 * round the wheel and no longer lines up with anything the chassis can feed. So the hood keeps
 * only the arc it needs to turn the element and let go of it, and the FIXED FEED THROAT (below)
 * takes over the entry.
 */
export const BB_HOOD_WRAP = 0.556;

/**
 * THE HOOD'S ARMS — how it hangs off the axle, since the side plates deliberately do not reach
 * it (the plates stop well below the hood).
 *
 * A real adjustable hood is an arc on two side arms that pivot on the shooter axle, and that is
 * what this is: `_T` is an arm's thickness in the arc's own plane. They go on the PITCH node with
 * the arc — they ARE the hood — which keeps the "only the hood moves" ruling exact: the flywheel
 * and the plates never move.
 *
 * APPROX: sized off the arc they carry. An arm's lateral WIDTH is DERIVED, from the channel and
 * `BB_HOOD_SIDE_CLEAR` below.
 */
export const BB_HOOD_ARM_T = 0.26;

/**
 * ⚠️ **THE ONE CLEARANCE THE WHOLE HOOD KEEPS TO EACH SIDE PLATE'S INNER FACE** (owner,
 * 2026-09-21: "the shooter's hood meshes with the shooter's parallel plates. It should be inside,
 * with a very slight gap").
 *
 * It is measured against `BbHeadDims.plateGap` — one element WIDE plus 0.30 — so the hood runs
 * `plateGap/2 − BB_HOOD_SIDE_CLEAR` at its widest on either side, at every elevation, and the
 * arms are what reach that bound (the arc itself stops one element radius out, inboard of them).
 * The head is NOT widened to buy it: `plateGap` is the channel the element, the flywheel tyre
 * (one element radius wide) and the feed all live in, and every one of those is measured off the
 * element rather than off this.
 *
 * MEASURED, both heads, 41 elevations: what shipped was 0.06 a side and the arms came out 0.09
 * thick; 0.08 leaves **0.07**, which is 14-gauge sheet (0.0747) — a real bracket. 0.10, the other
 * end of the range, leaves 0.05, thinner than any stock sheet. Nothing ever interpenetrated: the
 * hood arc sat 0.15 clear and the arms 0.06, and a triangle-AABB sweep of every moving mesh
 * against every fixed one finds the arms' pivot boss on the SHAFT it is journalled on and nothing
 * else. What 0.06 was, was invisible — an arm that close to a plate reads as part of it.
 */
export const BB_HOOD_SIDE_CLEAR = 0.08;

/**
 * THE FEED THROAT — the fixed channel the element rises through, and the rear tie between the
 * two side plates.
 *
 * ⚠️ **THIS IS WHAT FINALLY ANSWERS "THERE IS STILL A WEIRD FLAP IN THE BACK OF THE SHOOTER
 * THAT DOES NOTHING"** (owner, 2026-09-19 — the SECOND time it was reported). The pass before
 * this replaced a loose plank with a FEED SHOE: an arc at `hoodR + BB_HOOD_T + slide` spanning
 * 146°–202°, outboard of everything else on the machine and touching nothing you could see. It
 * was structure on paper and a floating curved flap on screen, which is why the same complaint
 * came back unchanged.
 *
 * What stands there now is the thing the element actually needs, in the place the new geometry
 * put it: the feed comes up the ROTATION AXIS, so the two side plates already ARE the throat's
 * cheeks and the only part missing is its BACK — one flat vertical wall, `BB_FEED_WALL_T` thick,
 * standing on the turret plate at the back of the rising element. It spans the whole channel and
 * both plate thicknesses, so it is also the rear tie — a plain cross member between the two side
 * plates, like the front standoffs, and nothing else. (It carried two EARS for the motor until
 * 2026-09-21; the side plate reaches the motor itself now, and a member that stands in for a side
 * plate is the bug the owner reported.) The turret plate is cut through beneath it, which is what
 * makes the path visible.
 *
 * `BB_FEED_SLIDE` is how far its FRONT FACE stands outboard of the hood's own outermost swept
 * radius. The hood sweeps a disc of radius `hoodR + BB_HOOD_T` about the axle, so a vertical
 * plane that clears that radius clears the hood at EVERY elevation — no angular bookkeeping, and
 * nothing to re-derive when `BB_TURRET_PITCH_MAX` moves.
 */
export const BB_FEED_SLIDE = 0.1;
export const BB_FEED_WALL_T = 0.25;

/**
 * THE DECK — the top of the drivetrain, where every mechanism is bolted (in off the tiles).
 *
 * The same 4.6 the renderer's side plates are built to (`BB_PLATE_H`); it is here because the
 * turret's whole stack is measured up from it and the stack is no longer the renderer's private
 * business. Anything that draws the drivetrain should read this rather than retyping it.
 */
export const BB_DECK_Z = 4.6;

/** the Box Tube's PIVOT AXLE height (in) — the tower leans about it, and `bbBoxTubeStages`
 * sizes the slide against the FLOWER's 21.404-in top plate from it. 0.7 over the deck puts the
 * base tube's foot 0.25 clear of the deck and keeps the stowed tower under `BB3_HEIGHT_MIN` on
 * every build (the RENDER lane measures it). */
export const BB_BOX_TUBE_Z = BB_DECK_Z + 0.7;

/** the slew ring the turret stands on, and the turret plate on top of it (in). A real turret is a
 * toothed ring bearing with a plate bolted to its inner race; APPROX both, sized as ordinary FTC
 * ring-bearing hardware. Both are BORED: the feed comes up through them. */
export const BB_TURRET_RING_H = 0.55;
export const BB_TURRET_PLATE_T = 0.25;
/** the top face of the turret plate — the surface everything on the turret stands on. */
export const BB_TURRET_PLATE_TOP_Z = BB_DECK_Z + BB_TURRET_RING_H + BB_TURRET_PLATE_T; // 5.40

/**
 * clearance between the turret plate and the bottom of the flywheel (in).
 *
 * ⚠️ **THIS IS THE OWNER'S "the flywheel can be situated much lower, it just needs to be right
 * above the turret plate".** The flywheel used to hang wherever the muzzle-pivot geometry left
 * it; it now sits one bearing block above the plate, which is what a flywheel shooter looks
 * like. Everything above it follows: the axle is plate + clearance + radius, and the muzzle is
 * axle + `pathR` rotated by the hood's angle. APPROX — a pillow block's own height.
 */
export const BB_FLYWHEEL_CLEAR = 0.3;
/** the flywheel axle's HEIGHT off the tiles (in) — the pivot the hood swings about, and the
 * origin of the AXLE FRAME every θ on this page is measured in. Wheel bottom lands at 5.70, and
 * it is the same for both heads: one wheel, one bearing block, one plate. */
export const BB_TURRET_AXLE_Z = BB_TURRET_PLATE_TOP_Z + BB_FLYWHEEL_CLEAR + BB_FLYWHEEL_R; // 7.11732

/**
 * THE SIDE PLATE — FOUR FLATS AND AN UNDERCUT, in the axle frame. `sidePlateR`
 * (`scene/renderRobots.ts`) is the profile and the only reader these three constants have; what
 * lives here is the three flats that are shared between the heads. The fourth, the REAR edge, is
 * per-head (`BbHeadDims.sideRearX`), and the undercut is derived from the feed wall and the motor.
 *
 * A FLAT FRONT past the standoffs, a FLAT TOP over the outgoing corridor, a FLAT BOTTOM that lands
 * on the turret plate, a FLAT REAR at the motor's own mount station, and one straight UNDERCUT
 * that takes the bottom up from the back of the feed wall into the motor boss. The top one is the
 * same number for either element by construction rather than by coincidence — see below.
 *
 * ⚠️ **IT IS ONE PIECE FROM THE MOTOR TO THE MUZZLE, AND THAT IS THE OWNER'S SECOND CORRECTION OF
 * 2026-09-21:** "the plate in the back that mounts the motor and the plate that retains the
 * flywheel should be the same plate." The plate used to stop at the hood's own radius (−3.917 in
 * the axle frame on a POLLEN head) and the motor hung off two EARS on the feed wall — a 1.47 ×
 * 0.22-in slab in the plate's exact plane, starting 0.63 in further back, with the wall's
 * perpendicular face in the gap. That is two pieces per side and it read as the step it was. A
 * real FTC shooter is two long parallel plates, each journalling the flywheel at one end and
 * carrying the motor at the other, and the ARC that used to close the rear is gone with the split:
 * it is now the rear FLAT, at the station the turret plate already ended at, so the head's swept
 * envelope did not move (measured: rear-most part `plateBackX` −3.650 in the turret frame, before
 * and after).
 *
 * ⚠️ **THE FLAT TOP IS THE OWNER'S "the arc in the parallel plates reaches too high; the hood
 * extends above the supporting plates".** It is not a taste offset: it is one element radius plus
 * 0.15 below the outgoing corridor's own centre line, i.e. the highest a fixed plate can reach
 * without fouling a flat shot. `pathR − elemR` is `BB_FLYWHEEL_R − BB_HOOD_COMPRESSION` whatever
 * the element is, so the corridor floor — and therefore this cut — is the SAME height for a
 * POLLEN head and a NECTAR head. That is why the number below has no element in it.
 *
 * ⚠️ **AND IT IS A *FORWARD* CUT, NOT A HEMISPHERE ONE — see `sidePlateR` (`scene/renderRobots.ts`),
 * which is the only reader this constant has.** Applied over the whole upper half it also cut the
 * plate away BEHIND the exit lip, where there is no outgoing corridor and where the hood, its tail
 * and the motor are — leaving the hood 2.95 in above anything fixed and carried by two 0.26-in
 * arms (owner item (B), 2026-09-19). The value here is unchanged; the angular range it binds over
 * is not. Nothing in the muzzle chain reads it.
 *
 * ⚠️ **AND PAST THE LIP IT DOES NOTHING AT ALL — IT STAYS AT THIS CUT** (owner, same day: "the
 * shooter parallel plates became ugly. remember that the arc does not need to be big"). One
 * attempt ramped up to the hood's radius over 22° and followed it round — 64° of arc and a hump
 * behind the wheel; the pass after that held the hood's radius for the whole wrap and came down a
 * rake. The top edge is now ONE straight line from the nose to the motor mount, so there is
 * nothing above this cut anywhere on the plate and no corner where two ideas met. Again the value
 * here did not move: this is a PICTURE, and the release chain is not allowed to pay for one.
 */
export const BB_SIDE_PLATE_TOP_Z = BB_FLYWHEEL_R - BB_HOOD_COMPRESSION - 0.15; // +0.96732 above the axle
/**
 * the flat FRONT cut, in the axle frame.
 *
 * ⚠️ **IT CAME DOWN FROM 3.6, AND WHAT SETS IT IS THE FRONT BRACES.** With the axle on the turret
 * axis a 3.6-in front was free; with the axle `pathR` forward of it, every inch of front reach is
 * an inch of head hanging past the turntable, so the plate is cut back to the smallest front that
 * still carries the front standoffs — `BB_TURRET_BRACES`' own outer edge at ±20°, 2.076, plus a
 * bolt rim.
 */
export const BB_SIDE_PLATE_FRONT_X = 2.2;
export const BB_SIDE_PLATE_BOTTOM_Z = BB_TURRET_PLATE_TOP_Z - BB_TURRET_AXLE_Z; // −1.71732 = the plate

/**
 * THE CROSS BRACES, as angle/radius sites in the axle frame.
 *
 * ⚠️ **THERE IS ONLY ONE PLACE LEFT FOR THEM, AND IT IS THE FRONT.** The element now rises up the
 * rotation axis and is carried from θ = 180° round to the lip, so the whole rear and upper half of
 * the interior is swept by either the element or the hood; below the wheel there is 0.30 in to the
 * turret plate. What is left is the front quadrant between the wheel's rim and the plate's own
 * flats, and all three sites sit in it at one radius, 0.200 clear of the rim.
 *
 * The +20° site is the one near the shot. Its top lands at 0.933 against a corridor floor of
 * 1.117 — 0.184 of clearance, where the old +20° brace had 0.133 — and nothing fixed can do
 * better than the side plate's own flat top, which clears by 0.150 by definition
 * (`BB_SIDE_PLATE_TOP_Z`). The −44° site is the low one: its bottom lands 0.091 above the plate.
 */
export const BB_TURRET_BRACE_R = 0.283;
export const BB_TURRET_BRACES: readonly { th: number; r: number }[] = [
  { th: 20 * BB_DEG, r: 1.91 }, //  front-top, under the corridor: 0.161
  { th: -20 * BB_DEG, r: 1.91 }, // front, 0.148 inside the plate profile
  { th: -44 * BB_DEG, r: 1.91 }, // front-bottom: 0.084 over the turret plate
];

/**
 * THE FLYWHEEL MOTOR — its can, the gap left between the can's front face and the feed wall it
 * stands behind, and the rim of plate left around it where it BOLTS.
 *
 * ⚠️ **IT BOLTS TO A SIDE PLATE, NOT TO THE FEED WALL'S EARS** (owner, 2026-09-21, second
 * correction on this mechanism: "the plate in the back that mounts the motor and the plate that
 * retains the flywheel should be the same plate"). The can's axis is LATERAL, so the part it can
 * face-mount to is a y = const plane — and the two side plates are the only ones the machine has.
 * The ears were a 1.47 × 0.22-in slab in exactly the side plate's own plane, starting 0.63 in
 * behind the plate's rear-most point and carried by the feed wall instead: two pieces per side
 * with a visible step between them. The side plate reaches the motor itself now
 * (`BbHeadDims.sideRearX`) and the ears are gone.
 *
 * ⚠️ **IT IS BEHIND THE HOOD NOW, AND THAT IS OWNER ITEM (a) OF 2026-09-19: "the motor should be
 * on the other side of the flywheel, behind the hood".** It used to sit at θ = −15°, forward and
 * under the wheel. Its SITE is not a choice any more — it is the only pocket the machine has
 * left. The hood sweeps a disc of radius `hoodR + BB_HOOD_T` from θ = 90° to 202°; the element
 * sweeps the annulus inside that from θ = 90° to 180° and then straight down the rotation axis;
 * the turret plate is 0.30 in under the wheel. So a motor at the BACK has to clear the hood's
 * whole swept disc, which puts it at θ = 180° (level with the axle, dead behind it) just outboard
 * of the feed wall — and its belt has to run OUTBOARD OF A SIDE PLATE, because the hood's own
 * shell lies across every line from the axle to it.
 */
export const BB_TURRET_MOTOR_R = 0.71;
export const BB_TURRET_MOTOR_GAP = 0.05;
/** the rim of plate left around the can where it bolts — what turns the plate's rear end into a
 * motor mount rather than a cut that grazes the pilot. It sets the side plate's rear edge
 * (`sideRearX`) AND the turret plate's own (`plateBackX`), which is why the two end at the same
 * station: one mount, one station. It was a bare `0.15` inside `bbHeadDims` and the renderer's
 * ear height (`2 · (BB_TURRET_MOTOR_R + 0.15)`) was a second copy of it. APPROX. */
export const BB_MOTOR_MOUNT_RIM = 0.15;

/** side-plate thickness, and how far every cross member stands PROUD of each plate's outer face
 * (owner, 2026-09-19: "i dont see the bracing" — a standoff the plate can occlude is a standoff
 * reported as missing). APPROX both: ordinary 1/4-in FTC plate and a washer stack. They are in
 * the chain rather than in the renderer because the TIE SPAN they add up to is what the turret
 * plate has to be wide enough to carry. */
export const BB_SHOOTER_PLATE_T = 0.22;
export const BB_BRACE_PROUD = 0.15;

/**
 * ONE HEAD'S DIMENSIONS — everything in the chain that depends on WHICH ELEMENT it throws.
 *
 * ⚠️ **OWNER ITEM (d), 2026-09-19: "the size of the shooter should be different for the pollen
 * shooter and the nectar shooter".** A hooded flywheel is sized by the thing that goes through
 * it: the hood stands one element DIAMETER off the wheel, the element's centre rides half that,
 * the channel between the plates is one element WIDE, and the axle sits forward of the rotation
 * axis by exactly the radius that centre path is drawn at. A 3.6-in NECTAR therefore gets a
 * visibly bigger head than a 2.8-in POLLEN, and so does its muzzle: 10.035 in at rest against
 * 9.635, which moves the arcs it solves.
 *
 * `bbTurretFor` (`mechs.ts`) is what decides which one a shot leaves from — turret 0 is the
 * POLLEN exit on every build, turret 1 is the DOUBLE turret's NECTAR exit and exists nowhere
 * else — so `which` is all a caller ever needs to pass.
 */
export interface BbHeadDims {
  /** the element this head is built around (in). */
  readonly elemR: number;
  /** the hood's INNER radius about the axle: wheel + one element diameter, less the compression. */
  readonly hoodR: number;
  /** the radius the element's CENTRE travels at — the one that sets the muzzle. */
  readonly pathR: number;
  /** how far FORWARD of the turret's rotation axis the flywheel axle sits. Equal to `pathR`, so
   *  the element pinches on the axis it came up. */
  readonly axleX: number;
  /** the clear width between the two side plates, one element wide plus a working clearance. */
  readonly plateGap: number;
  /** the feed wall's FRONT face, as a radius from the axle (the hood's swept disc plus slide). */
  readonly wallR: number;
  /** the flywheel motor's axis, as a radius from the axle, at θ = 180° — dead behind the wheel,
   *  level with it, and outboard of everything the hood sweeps. */
  readonly motorR: number;
  /** the SIDE PLATE's rear edge, in the AXLE frame: one can radius plus a mount rim behind the
   *  motor's axis. ⚠️ It is the same station `plateBackX` puts the TURRET plate's rear at — the
   *  motor's mount is what sets both — so the head's rear-most extent does not move when the side
   *  plate grows back to reach the motor. */
  readonly sideRearX: number;
  /** what every member that ties the two side plates together spans: the channel, both plate
   *  thicknesses and the proud ends. */
  readonly tieSpan: number;
  /** the turret plate, in the TURRET frame — a rounded rectangle, not a disc. It reaches from
   *  behind the motor mount to just past the wheel and is one tie span plus a rim wide, which is
   *  the shape of the thing standing on it; a disc big enough to do the same job would be 8.4 in
   *  across on a 14.5-in robot and would sweep further than the shooter itself at some yaw. */
  readonly plateBackX: number;
  readonly plateFrontX: number;
  readonly plateHalfW: number;
  /** the plate's feed slot: a rounded rectangle about the rotation axis, in the TURRET frame. */
  readonly slotBackX: number;
  readonly slotFrontX: number;
  readonly slotHalfW: number;
  /** the head's own fore-aft extent in the TURRET frame — the motor's rear face and the side
   *  plate's nose. What a mount has to find room for. */
  readonly backX: number;
  readonly frontX: number;
}

function bbHeadDims(elemR: number): BbHeadDims {
  const hoodR = BB_FLYWHEEL_R + elemR * 2 - BB_HOOD_COMPRESSION;
  const pathR = hoodR - elemR;
  const axleX = pathR;
  const wallR = hoodR + BB_HOOD_T + BB_FEED_SLIDE;
  const motorR = wallR + BB_FEED_WALL_T + BB_TURRET_MOTOR_GAP + BB_TURRET_MOTOR_R;
  const backX = axleX - motorR - BB_TURRET_MOTOR_R;
  const plateGap = elemR * 2 + 0.3;
  const tieSpan = plateGap + 2 * BB_SHOOTER_PLATE_T + 2 * BB_BRACE_PROUD;
  return {
    elemR,
    hoodR,
    pathR,
    axleX,
    plateGap,
    wallR,
    motorR,
    sideRearX: -(motorR + BB_TURRET_MOTOR_R + BB_MOTOR_MOUNT_RIM),
    tieSpan,
    // it carries the motor's mount, the feed wall and the whole wheel's footprint; only the side
    // plates' NOSE cantilevers past it, and the plate's own rounded corner stays inside that nose
    // so the widest thing on a slewing head is the shooter and not its turntable
    plateBackX: backX - BB_MOTOR_MOUNT_RIM,
    plateFrontX: axleX + BB_FLYWHEEL_R + 0.15,
    plateHalfW: tieSpan / 2 + 0.2,
    slotBackX: axleX - wallR, // = −(elemR + BB_HOOD_T + BB_FEED_SLIDE): the wall's own front face
    slotFrontX: elemR + 0.25,
    slotHalfW: elemR + 0.25,
    backX,
    frontX: axleX + BB_SIDE_PLATE_FRONT_X,
  };
}

/** the POLLEN head — turret 0 on every turreted build. */
export const BB_HEAD_POLLEN = bbHeadDims(BB_POLLEN_R);
/** the NECTAR head — turret 1, which only a DOUBLE turret has. */
export const BB_HEAD_NECTAR = bbHeadDims(BB_NECTAR_R);
/** the head turret `which` is built to. */
export function bbHead(which: 0 | 1): BbHeadDims {
  return which === 1 ? BB_HEAD_NECTAR : BB_HEAD_POLLEN;
}

/** the POLLEN head's channel, in inches — the 2D sprite's, and the one number the rest of the
 * app means when it says "the launcher's plate gap". The 3D scene reads `BbHeadDims.plateGap`
 * per head instead, because a NECTAR channel is 0.8 in wider. */
export const BB_LAUNCH_PLATE_GAP = BB_HEAD_POLLEN.plateGap;

/** the hood's inner radius and the element's path radius, for the POLLEN head. Named exports
 * because the 2D sprite, the smoke lanes and the docs all speak of "the" hood radius, and a
 * single turret is always the POLLEN head. */
export const BB_HOOD_R = BB_HEAD_POLLEN.hoodR; // 3.91732
export const BB_HOOD_PATH_R = BB_HEAD_POLLEN.pathR; // 2.51732

/**
 * how many fixed-point passes `bbTurretSolution` makes over the pitch (see `bbMuzzleLocal`).
 *
 * ⚠️ **THE SOLVE IS A FIXED POINT NOW, AND IT IS BOUNDED RATHER THAN TOLERANCED.** The muzzle
 * FOLLOWS THE HOOD (owner, 2026-09-19, asked and answered), so the elevation sets the release —
 * height and setback both — and the release sets the elevation. A `while (err > tol)` would be a
 * loop whose trip count depends on floating point, which in a lockstep sim is a loop that can
 * run a different number of times on two machines. Four passes, always, no early exit, no
 * tolerance.
 *
 * MEASURED, sweeping the whole 2-in field grid at both HIVE cells (7,688 poses): a FIFTH pass
 * moves the pitch by at most **1.76e-9 rad** — 3.4e-6 of a degree, which at the longest shot on
 * the field is under a thousandth of an inch at the opening. The map contracts hard because the
 * release moves by well under an inch per degree of pitch at HIVE ranges. Three passes would
 * very likely do; four is one more than the measurement needs and still a fixed cost.
 *
 * ⚠️ **IT IS ALSO THE LEAD'S PASS COUNT, AND THAT IS ONE LOOP AND NOT TWO** (owner, 2026-09-19:
 * "animate the turret properly so that it has a 'shooting on the move' correction algorithm built
 * in"). A shot inherits the muzzle's own velocity now, so the solve aims at the target DISPLACED
 * BY `−v · t_flight`, and `t_flight` is a function of the solution — a second fixed point over the
 * first. Folding it into these same four passes is what keeps the trip count fixed AND keeps a
 * PARKED robot byte-identical: every lead term is multiplied by a velocity that is exactly zero,
 * so `bbTurretSolution` of a stopped robot computes the same floats it always did (the ROBOT lane
 * pins it, and the scoreable-cell counts of 1382 north / 1439 south do not move).
 *
 * MEASURED residual of the lead at four passes — how far from the cell centre the solved shot
 * actually lands, over 4,096 field poses × 8 headings at the drivetrain's own top speed, turret
 * exactly on solution: see `BB_TURRET_ACCEL`'s neighbours in `robot.ts`'s `bbTurretSolution`
 * header, which carries the table.
 */
export const BB_TURRET_SOLVE_PASSES = 4;

/** shooter cadence (s between shots) — 13 elements/s PER TURRET EXIT. The clock is one beat
 * shared by both turrets of a double (one `fireReadyAt`, one wire field, one hopper), and every
 * exit that is loaded and on target releases on it. The turret ACCUMULATES this
 * interval rather than re-anchoring to `world.time`, so the sub-tick remainder carries and
 * the long-run rate averages exactly 13/s instead of tick-quantizing to 12 or 15. APPROX. */
export const BB_FIRE_INTERVAL = 1 / 13;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — chassis envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The EXPANSION PRISM (in) a robot may grow into once the match starts — R105.A (V1, p122):
 * "at all times must remain within a 18 in. (45.70 cm) by 24 in. (61.0 cm) by 29 in. (73.65 cm)
 * tall sizing volume when fully expanded". Manual numbers, not a guess.
 *
 * TWO horizontal dimensions, and the rule does not say which chassis axis gets which: the
 * volume is oriented only in HEIGHT ("the 29 in. dimension is always the vertical height"). So
 * a robot may grow to 24 along ONE horizontal axis while staying within 18 along the other,
 * and it may pick either. `BB_PRISM` is the long side, `BB_PRISM_NARROW` the short one.
 * `BB_EXPANSION` is what the long side leaves past R102's 18" starting cube.
 */
export const BB_PRISM = 24;
export const BB_PRISM_NARROW = 18;
export const BB_EXPANSION = BB_PRISM - ROBOT_MAX_SIZE; // 6" past the starting cube

/**
 * Chassis size range (in), BOTH axes — the range BIOBUZZ itself wants.
 *
 * The CEILING is R102's 18" starting cube (owner, 2026-09-24: it was 17, "a working inch for the
 * bumper", which no rule asks for). The FLOORS are DECODE's per-intake floors, because there is
 * no BIOBUZZ rule to argue a different one from: V1 sets robot size CEILINGS (R102, R105) and no
 * minimum, and its start rule (G304) is a set of pose clauses rather than a start zone a small
 * chassis would have to fill. The floors are APPROX.
 */
export const BB_MIN_LENGTH = 13.5;
export const BB_MAX_LENGTH = ROBOT_MAX_SIZE;
export const BB_MIN_WIDTH = 14.5;
export const BB_MAX_WIDTH = ROBOT_MAX_SIZE;

/**
 * CHASSIS SIZE LIMITS, per build.
 *
 * The SWEEPER DEPLOYS, so it does not have to fit inside R102's 18"
 *    starting cube alongside the chassis — that is what most real FTC intakes do. But it is
 *    real structure once deployed, so chassis + sweepers must fit R105.A's 18 × 24 EXPANSION
 *    prism, and which AXIS it eats depends on the mount, which is the whole point of having
 *    mounts:
 *      • front / back → one reach off the LENGTH
 *      • front+back   → TWO reaches off the LENGTH (a sweeper on each end)
 *      • side         → TWO reaches off the WIDTH (a sweeper on each flank)
 *    THE BOX TUBE COUNTS TOO. Its placement point (`bbPlacePointLocal`) sits `BB_PLACE_REACH`
 *    past the footprint along the tube's mount direction, and the tube is the structure that
 *    reaches it, so it occupies that much of the envelope: an END mount off the length, a
 *    FLANK mount off the width, and a CORNER mount its diagonal's component off BOTH. It used
 *    to be left out, which let the builder offer a maxed chassis whose tube poked past R105.
 *    NOT floored to the minimum on purpose: when the deployed sweepers leave nothing legal
 *    the max drops BELOW the min, and `bbMountFits` is what reports that combination as
 *    impossible. Flooring here would instead hand back a robot that overruns the prism.
 *
 *    ⚠️ R105 DOES NOT SAY WHICH AXIS IS THE 24, so there are two candidate rectangles — the
 *    LENGTH axis long, or the WIDTH axis long — and the legal set is their UNION, which is not
 *    a rectangle two independent sliders can describe. So the WIDTH RANGE DEPENDS ON THE
 *    LENGTH: the length range is the union's, and the width range is the widest one offered by
 *    any rectangle that holds the current length. The coercer clamps length first and then
 *    reads the width range off the clamped length, so it is still idempotent.
 *
 *    It used to pick ONE rectangle per build instead (widest pair of ranges). With the ceiling
 *    at 17 that never cost anything that mattered; at 18 it made a front sweeper + flank tube
 *    build pick 18 × 15.5 over 15 × 18, and shrink every saved 15 × 17 build of that shape.
 *
 * ⚠️ DECODE'S PER-INTAKE CEILINGS DO NOT APPLY (owner, 2026-09-24). `lengthLimits` caps a
 * sloped chassis at 15 because in DECODE the roller sits INSIDE the 18" start cube (18 − reach).
 * A BIOBUZZ sweeper deploys, so that rule capped every BIOBUZZ build at 15 long for no reason.
 * Only their FLOORS are kept (a funnel still needs its frame). `src/sim/spawn.ts` carries the
 * raw length and width across to `coerceBiobuzzSpec`, so this is the only size clamp a BIOBUZZ
 * spec meets, and the builder never offers a size the coercer refuses.
 *
 * ⚠️ THE PRISM-DERIVED MAXIMUMS ARE FLOORED TO `BB_SIZE_STEP`. A corner Box Tube reaches
 * `BB_PLACE_REACH · √½` (1.669…) along each axis, so `18 − reach` is 16.331227996399747, and the
 * coercer clamped a chassis to exactly that, which the builder printed as a 15-digit width
 * (owner report, 2026-09-13). Flooring keeps the limit inside the prism, keeps coercion
 * idempotent, lands every clamped size on the slider's own grid, and re-coerces a robot already
 * saved with the long number onto it.
 */
export function bbSizeLimits(spec: RobotSpec): {
  minLength: number;
  maxLength: number;
  minWidth: number;
  maxWidth: number;
} {
  return bbEnvelope(spec).limits;
}

/**
 * How far past the CHASSIS box this build's deployed structure reaches along each chassis
 * axis, in total over both ends of that axis (in): sweepers plus the Box Tube. The one
 * description of "what R105 has to contain besides the frame", shared by `bbSizeLimits` and
 * the smoke lane, so the envelope and the check against it cannot measure different robots.
 */
export function bbEnvelopeReach(spec: RobotSpec): { length: number; width: number } {
  const reach = INTAKE_PRESETS[spec.intake].reach;
  const mount = bbIntakeMountOf(spec);
  const ends = mount === 'front' || mount === 'back' ? 1 : mount === 'frontback' ? 2 : 0;
  const flanks = mount === 'side' ? 2 : 0;
  const lift = bbLiftOf(spec);
  // `Math.abs` of the exact unit vector: 1 on the axis an edge mount points along, 0 on the
  // other, and SQRT1_2 on both for a corner, which is where a diagonal tube's tip actually is.
  const tube = lift ? MOUNT_DIR[lift.mount] : { x: 0, y: 0 };
  return {
    length: ends * reach + Math.abs(tube.x) * BB_PLACE_REACH,
    width: flanks * reach + Math.abs(tube.y) * BB_PLACE_REACH,
  };
}

/** the Frame sliders' step (in) — and the grid a size LIMIT derived from the prism is floored to
 * (`bbSizeLimits`), so a clamped chassis is never a 15-digit number. The builder reads this. */
export const BB_SIZE_STEP = 0.5;

/** `v` floored to `BB_SIZE_STEP`, with a hair of tolerance so a limit that is already on the
 * grid (17, 16.5) is not knocked a whole step down by float noise. */
function floorToSizeStep(v: number): number {
  return Math.floor(v / BB_SIZE_STEP + 1e-9) * BB_SIZE_STEP;
}

/**
 * A CHASSIS SIZE ON THE SLIDER'S OWN GRID — `v` to the NEAREST `BB_SIZE_STEP`.
 *
 * ⚠️ THE 2026-09-13 FIX WAS HALF OF ONE, AND THE OWNER RE-REPORTED IT (2026-09-18). Flooring the
 * prism-derived LIMITS stopped the coercer from *creating* 16.331227996399747 — but nothing ever
 * snapped the VALUE, so a robot saved with that width before the fix keeps it forever: the
 * default build's width ceiling is 17, the clamp has nothing to do, and the builder prints all
 * fifteen digits. Measured: `coerceBiobuzzSpec({…, width: 16.331227996399747})` returned it
 * unchanged. Snapping in the coercer is what HEALS a stored spec, and because the coercer is the
 * one chokepoint every spec passes — localStorage, the wire, `createWorld`, the server's own
 * pass — the client and the server land on the same number, so `bbSpecKey` still agrees.
 *
 * Rounding, not flooring: this is a value a player chose, and the nearest legal dial position is
 * the honest repair. It is IDEMPOTENT (a grid value rounds to itself) and it cannot leave the
 * legal range, because every limit `bbSizeLimits` reports is already on this grid (smoke asserts
 * that separately) and the caller re-clamps anyway.
 */
export function bbSnapSize(v: number): number {
  return Math.round(v / BB_SIZE_STEP) * BB_SIZE_STEP;
}

/** the resolved envelope: the slider limits (the width range read off `spec.length`), which
 * rectangle of R105.A holds the build at that length (`lengthLong` — the 24 runs along the
 * chassis LENGTH), and whether any rectangle's minimum chassis fits the prism at all. See
 * `bbSizeLimits` for the rule. */
function bbEnvelope(spec: RobotSpec): {
  limits: { minLength: number; maxLength: number; minWidth: number; maxWidth: number };
  lengthLong: boolean;
  prismFits: boolean;
} {
  const ext = bbEnvelopeReach(spec);
  // the shared per-intake / per-drivetrain FLOORS only — their ceilings are DECODE's in-cube
  // intake rule, which a deploying sweeper does not answer to (see `bbSizeLimits`)
  const minLength = Math.max(BB_MIN_LENGTH, lengthLimits(spec.intake).min);
  const minWidth = Math.max(BB_MIN_WIDTH, widthLimits(spec.intake, spec.drivetrain).min);
  const candidate = (lengthLong: boolean) => {
    const capL = lengthLong ? BB_PRISM : BB_PRISM_NARROW;
    const capW = lengthLong ? BB_PRISM_NARROW : BB_PRISM;
    const limits = {
      minLength,
      maxLength: Math.min(BB_MAX_LENGTH, floorToSizeStep(capL - ext.length)),
      minWidth,
      maxWidth: Math.min(BB_MAX_WIDTH, floorToSizeStep(capW - ext.width)),
    };
    // THE MINIMUM CHASSIS, not the max: the coercer widens an inverted range UP to the floor,
    // so the floor is the size a build actually gets when nothing else fits, and it has to be
    // inside the prism for the rectangle to be honest.
    const prismFits = minLength + ext.length <= capL + 1e-9 && minWidth + ext.width <= capW + 1e-9;
    const usable = prismFits && limits.maxLength >= minLength && limits.maxWidth >= minWidth;
    return { limits, lengthLong, prismFits, usable };
  };
  const a = candidate(true);
  const b = candidate(false);
  const usable = [a, b].filter((c) => c.usable);
  // NOTHING BUILDABLE: report the rectangle whose minimum fits, if either, so `bbMountFits`
  // sees the inverted range and says no.
  if (usable.length === 0) {
    const pick = !a.prismFits && b.prismFits ? b : a;
    return { limits: pick.limits, lengthLong: pick.lengthLong, prismFits: pick.prismFits };
  }
  const maxLength = Math.max(...usable.map((c) => c.limits.maxLength));
  // the length this build will actually have once clamped (a non-finite one is the coercer's to
  // replace, so it constrains nothing here)
  const len = Number.isFinite(spec.length) ? Math.min(Math.max(spec.length, minLength), maxLength) : minLength;
  const holding = usable.filter((c) => len <= c.limits.maxLength + 1e-9);
  const best = holding.reduce((x, y) => (y.limits.maxWidth > x.limits.maxWidth + 1e-9 ? y : x));
  return {
    limits: { minLength, maxLength, minWidth, maxWidth: best.limits.maxWidth },
    lengthLong: best.lengthLong,
    prismFits: true,
  };
}

/**
 * Can this intake preset be mounted this way at all, with this loadout?
 *
 * FALSE when the deployed sweepers plus the Box Tube leave no chassis inside R105.A's prism
 * (a front+back triangle sweeper with a tube on an end, for one), or when the size range is
 * empty. Kept, and kept CALLED, on purpose: it is the one place that answers "is this build
 * possible" for both the coercer and the builder's greying-out, and re-deriving that at two
 * call sites is exactly how the two drift apart.
 *
 * The coercer's fallback for a mount that does not fit is `front`, and `front` is always
 * PRISM-legal at the floor: the deepest sweeper (5) plus a full end tube (2.36) on the 13.5
 * floor is 20.9 of 24, and a flank tube on the widest floor (15.5) is 17.9 of 18.
 */
export function bbMountFits(spec: RobotSpec, mount: BbIntakeMount): boolean {
  const e = bbEnvelope({ ...spec, intakeMount: mount });
  const l = e.limits;
  return e.prismFits && l.maxLength >= l.minLength && l.maxWidth >= l.minWidth;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — hopper capacity
// ─────────────────────────────────────────────────────────────────────────────

/** a floor of one POLLEN; NOT scaled with the rest. */
export const BB_STORAGE_MIN = 1;
/**
 * CEILING: **4 elements, POLLEN and NECTAR together. This is an OWNER RULING (2026-09-12), final.**
 *
 * In the manual, G407 ("A ROBOT may not CONTROL more than 4 SCORING ELEMENTS") starts at a
 * VERBAL WARNING, with MAJOR + YELLOW when STRATEGIC (Table 10-4). The sim caps the hopper at
 * 4 anyway, so a robot cannot hold a fifth element. The owner's ruling overrides the earlier
 * request to lift this cap (Lane B relay 2, field-plan §4.3). The rules lane's G407 test
 * (`penalties.ts`, `BB_CONTROL_LIMIT`) stays as written. It is a separate number, and it still
 * catches anything that reaches five without going through the hopper.
 *
 * The staging rule agrees from the other side: §10.3.1 pre-loads exactly 4 POLLEN per ROBOT,
 * so a legal robot starts FULL.
 *
 * ── THE VOLUME LAW IS KEPT UNDERNEATH ──────────────────────────────────────
 * `bbStorageMax` still runs the one-layer packing model (~12 in² of hopper floor per 3" POLLEN)
 * and the archetype/mount multipliers. They remain the honest description of the hardware. The
 * cap binds first for every chassis in the legal envelope, and the volume law stays written
 * down so it takes over again if the ruling ever changes. The number a robot may hold is the
 * SMALLER of what fits and what the ruling allows.
 *
 * ⚠️ CONSEQUENCE: the storage slider is a 1–4 dial and every archetype reaches the same
 * ceiling, so hopper size does not tell two builds apart. Cadence, range and cycle time do.
 */
export const BB_STORAGE_MAX = 4;
/** a legal robot starts FULL: §10.3.1 stages exactly 4 pre-loaded POLLEN per ROBOT. */
export const BB_STORAGE_DEFAULT = 4;

/** square inches of footprint per stored POLLEN — the derived cap's only size term, so it is
 * the single dial for storage across every archetype, mount and chassis size. APPROX: a
 * one-layer packing model, ~12 in² of hopper floor per 3" POLLEN. */
export const BB_STORE_AREA_PER_BALL = 12;
export const BB_STORE_TURRET_MULT = 0.55; // a turret loses centre volume to the rotor + shooter
export const BB_STORE_TWIN_MULT = 0.45; // a second shooter assembly eats even more of it
export const BB_STORE_LAUNCHER_MULT = 1.0; // dumper: open hopper
/** INTAKE MOUNT storage cost — every mounted edge is an OPENING the hopper cannot use.
 * front and back are mirror images (one open end), so a rear sweeper is a free stylistic
 * choice; two mounts cost real volume. SIDE is harshest, because the flanks run the full
 * chassis LENGTH — that is the price of collecting a stream you drive alongside. */
export const BB_STORE_SIDE_MULT = 0.6;
export const BB_STORE_FRONTBACK_MULT = 0.75;

/** the hopper-volume factor an intake mount costs (1 = no cost). */
export function bbMountStoreMult(mount: BbIntakeMount): number {
  if (mount === 'side') return BB_STORE_SIDE_MULT;
  if (mount === 'frontback') return BB_STORE_FRONTBACK_MULT;
  return 1; // front / back — a single open end, mirror images of each other
}

/** the MAX POLLEN this robot can hold — footprint × an archetype factor × the intake-mount
 * factor, clamped to [MIN, MAX].
 *
 * The volume law below describes the HARDWARE and `BB_STORAGE_MAX` is the owner's 4-element cap
 * (2026-09-12). For every chassis in the legal size envelope the volume answer is larger, so the
 * cap is what actually binds and this returns 4. See the note on `BB_STORAGE_MAX` for why both
 * layers are kept. */
export function bbStorageMax(spec: RobotSpec): number {
  const area = spec.length * spec.width;
  // Through the RESOLVER, not `spec.scoreMode`: the container is authoritative and the flat
  // field only mirrors it (a legacy `drum` reads as a dumper here too).
  const kind = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG).kind;
  const mult =
    (kind === 'turret'
      ? BB_STORE_TURRET_MULT
      : kind === 'twinturret'
        ? BB_STORE_TWIN_MULT
        : BB_STORE_LAUNCHER_MULT) * bbMountStoreMult(bbIntakeMountOf(spec));
  const cap = Math.round((area / BB_STORE_AREA_PER_BALL) * mult);
  return Math.max(BB_STORAGE_MIN, Math.min(BB_STORAGE_MAX, cap));
}

/**
 * The robot's ACTIVE hopper capacity: its chosen `ballStorage`, clamped to its
 * archetype+size max. Read by the sim (the intake cap), the renderer (how full to draw the
 * hopper) and the HUD, so all three agree on one number.
 *
 * It lives HERE rather than in `robot.ts` even though the contract lists it as a robot export,
 * because `elements.ts` needs the cap to know whether a capture fits and importing `robot.ts`
 * for it would make an elements↔robot cycle. `robot.ts` re-exports it under the contract name.
 */
export function bbHopperCap(spec: RobotSpec): number {
  const want = Math.round(spec.ballStorage ?? BB_STORAGE_DEFAULT);
  return Math.max(BB_STORAGE_MIN, Math.min(bbStorageMax(spec), want));
}

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — MASS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **THE MASS FLOOR IS A BUILD-UP OF THIS GAME'S OWN HARDWARE, NOT DECODE'S PLUS A BUMP**
 * (owner, 2026-09-22: "Focus on the mass of each component... Single intake single turret
 * should weigh like 18lbs minimum").
 *
 * What it replaces: `massLimits(drivetrain, inertia, bbMassFloorBump(spec))`, whose base was
 * DECODE's `DRIVETRAIN_LIMITS` (mecanum 18, tank 22, swerve 21.5, butterfly 24) and whose bump
 * priced exactly two things — a second turret and a Box Tube. So a SWEEPER weighed nothing, a
 * TURRET weighed nothing, a DUMPER weighed nothing, and a second sweeper edge weighed nothing:
 * a bare mecanum chassis and a mecanum chassis carrying a turret and two sweepers had the same
 * floor, 18 lb. And DECODE's 18 is not a bare chassis at all — it already prices in DECODE's
 * own shooter, which is why every BASE below is LIGHTER than the number it replaces.
 *
 * Every constant here is APPROX with its reason on its own line. R104 sets NO ROBOT weight
 * limit in BIOBUZZ, so none of this is a rules clamp: it is the sim's model of what a given
 * pile of hardware has to weigh, and the CEILING is the shared drivetrain envelope (what that
 * drivetrain can still move), not a rule.
 */

/**
 * BARE CHASSIS (lb) — frame, wheels, drive motors, battery and the two hubs, and NOTHING that
 * touches an element. One line of reasoning each:
 *  • mecanum   four motors, four mecanum wheels, rails, battery, two hubs. THE CALIBRATION
 *              POINT: 11.5 + one sweeper (1.5) + one turret (5) = 18.00 lb.
 *  • xdrive    the same four motors and four roller wheels, turned 45° — a wash, so the same.
 *  • tank      6WD: two more wheels, the sprockets and the chain runs between them.
 *  • swerve    four steering modules and four more motors on top of the four drive ones.
 *  • butterfly both wheel sets plus the actuators that swap them — the heaviest archetype, and
 *              the literal cost of it (the same ordering the shared model has).
 */
export const BB_MASS_BASE: Readonly<Record<DrivetrainType, number>> = {
  mecanum: 11.5,
  xdrive: 11.5,
  tank: 13,
  swerve: 15.5,
  butterfly: 17,
};

/** one SWEEPER edge (lb): a roller bar, its motor and gearbox, and the two side plates that
 * carry it. Charged PER MOUNTED EDGE, so `frontback` and `side` pay twice — which is the point:
 * the second edge is a second whole assembly and it used to be free. APPROX. */
export const BB_MASS_SWEEPER_EDGE = 1.5;
/** a SINGLE TURRET (lb): the flywheel and its hood, the rotor ring the head yaws on, and the
 * two motors. The heaviest single mechanism in the game — it is a whole aiming assembly, not a
 * chute. APPROX. */
export const BB_MASS_TURRET = 5;
/** the SECOND turret of a DOUBLE (lb), on top of `BB_MASS_TURRET`. A whole second assembly —
 * its own flywheel, hood, ring and motors — but it shares the hopper and the feed the first one
 * already pays for, so it is a little under a first turret. APPROX. */
export const BB_MASS_TURRET2 = 3.5;
/** a DUMPER (lb): a tilting hopper on a pivot and one motor to heave it. No stored energy and
 * no aiming hardware, so it is well under a turret — which is the archetype's real tradeoff.
 * APPROX. */
export const BB_MASS_DUMPER = 3.5;
/** a BOX TUBE (lb): the three nested tubes (`BB_BOX_TUBE_SECTIONS`), the pivot plates, the
 * spool, the wrist servo and the claw. Offset lists its 2-stage Box Tube Slide Kit at about
 * 475 g (1.05 lb, 275 g of it moving); the wrist and claw take it to 1.5 (owner, 2026-09-24:
 * "the whole mechanism should be somewhat light… 1.5 lbs max"). It was 2.5. */
export const BB_MASS_BOX_TUBE = 1.5;

/**
 * THE MASS RANGE THIS BUILD MAY BE DIALLED TO (lb) — the ONE model, read by the coercer
 * (`coerce.ts`), by the builder's slider (`bbDials`) and by both preset lists.
 *
 * The FLOOR is the sum of what the build is made of; the CEILING is the shared per-drivetrain
 * envelope, which is a statement about what that drivetrain can still move and NOT a rules
 * limit — R104 sets no robot weight limit, so there is no legal number to use here.
 *
 * ROUNDED TO 0.01, for the reason `massLimits` documents at length: the floor is a sum of
 * decimal constants and binary floating point turns e.g. 15.5 + 1.5 + 1.5 into something ending
 * in ...0000003, which then becomes the robot's actual clamped mass and is printed as-is.
 *
 * Read through `bbLauncherOf` / `bbLiftOf` / `bbIntakeMountOf` rather than off the flat mirror
 * fields: the container is authoritative.
 */
/** the builder's MASS slider step (lb). Every part above is a whole or half pound, so every
 * floor is on this grid, and so is a mass anywhere between. It was 1, anchored at each build's
 * own floor, so a 19.5-lb floor put 23 off the grid and a 23.5-lb seed sat under a thumb at 24. */
export const BB_MASS_STEP = 0.5;

export function bbMassLimits(spec: RobotSpec): { min: number; max: number } {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const mount = bbIntakeMountOf(spec);
  const edges = mount === 'frontback' || mount === 'side' ? 2 : 1;
  const raw =
    (BB_MASS_BASE[spec.drivetrain] ?? BB_MASS_BASE.mecanum) +
    edges * BB_MASS_SWEEPER_EDGE +
    (launcher.kind === 'dumper' ? BB_MASS_DUMPER : BB_MASS_TURRET) +
    (launcher.kind === 'twinturret' ? BB_MASS_TURRET2 : 0) +
    (bbLiftOf(spec) ? BB_MASS_BOX_TUBE : 0);
  const max = DRIVETRAIN_LIMITS[spec.drivetrain]?.maxMass ?? DRIVETRAIN_LIMITS.mecanum.maxMass;
  return { min: Math.min(Math.round(raw * 100) / 100, max), max };
}

// ─────────────────────────────────────────────────────────────────────────────
// START ANCHORS
// ─────────────────────────────────────────────────────────────────────────────

export interface BbStartAnchor {
  /** the anchor's name in the CANONICAL (blue) frame — see `bbAnchorName` for what a player sees */
  name: string;
  /** which perimeter wall the robot backs onto, in the canonical frame */
  wall: 'rear' | 'audience' | 'side';
  pos: { x: number; y: number };
  heading: number;
}

/**
 * The named start anchors — CANONICAL for BLUE (goal side +x); RED is the POINT mirror
 * (`bbMirror`), applied once in `spawn.ts` so no other file mirrors anything.
 *
 * TWO anchors, because a BIOBUZZ alliance is two robots and each locks one so they cannot
 * stack. There is no third or fourth because there is no known reason for one: CR's extra
 * pair existed to put a robot on a Ring Stand, and BIOBUZZ has no such structure.
 *
 * ── THEY ARE ON THE REAR AND AUDIENCE WALLS, AND THAT IS G304 ──────────────
 * G304 (manual-distilled §6.2, p104) asks a start pose for four things at once: fully on the
 * alliance's own side (A), TOUCHING the perimeter wall (C), clear of every FLOWER foot and
 * scoring volume (D), and NOT in the LOADING ZONE (E). C and E fight: a robot must be against
 * the perimeter, and the LOADING ZONE is itself against the perimeter — so the legal frontage
 * is the wall MINUS that zone. Blue's zone (`BB_LZ.blue`, x ∈ [61, 72]) eats the useful middle
 * of blue's own SIDE wall, which is exactly where both anchors used to sit.
 *
 * So they moved to the two walls an alliance shares with nobody's zone:
 *
 *   index 0  REAR wall     (34, wall−10.5) facing −y.  x = 34 keeps the footprint clear of
 *                          blue's GARDEN strip (x ≥ 47.4) and of F2, on RED's half at x = −23.4.
 *   index 1  AUDIENCE wall (46, −(wall−10.5)) facing +y. x = 46 clears F4's foot (x ∈ [20.4,
 *                          26.4]) by seven inches on one side and blue's LOADING ZONE
 *                          (x ≥ 59.1) by thirteen on the other.
 *
 * THE WALL-NORMAL COORDINATE IS WRITTEN AS `BB_HALF_* − CHASSIS_HALF`, NOT AS A LITERAL. It used
 * to be ±61.5, i.e. ±72 less a default chassis half-extent of 10.5, and the ±72 was wrong: the
 * CAD wall is at ±70.674, so a literal would now hover 1.33 in off the wall and G304.C wants the
 * robot TOUCHING it. Spec-dependent by nature — a deeper sweeper reaches further — so
 * `bbSnapStart` still re-seats per build; it has a hair to move, not a foot.
 *
 * ⚠️ **NO LONGER APPROX.** Both shapes these poses are measured against are now CAD: `BB_LZ` is
 * the union of three measured tape strips and `BB_FLOWER_FOOT` is CAD-confirmed to 0.05 in
 * (audit §6). The generous along-wall margins stay as they are — they were cover for the tape
 * slop, and the zones moving inward by ~1.9 in only widened them.
 *
 * ORDER IS LOAD-BEARING: a 2-robot alliance defaults to anchors 0 and 1, so index 0 must be
 * the TOP (y ≥ 0) anchor and index 1 the BOTTOM one (`bbAnchorCat`). They are 123 in apart —
 * opposite ends of the field — so two robots of one alliance cannot reach each other at the
 * buzzer, which is the whole reason there are two.
 */
/**
 * the default build's half-extent on its WALL side (in) — what seats an anchor against the wall
 * it names. `bbSnapStart` re-seats per spec; this only has to be close.
 *
 * ⚠️ IT IS A MEASUREMENT OF `BB_DEFAULT_SPEC`, so it moves when the default preset does. Every
 * anchor is written facing INTO the field, so the wall side is the BACK of the robot: 7.5 is the
 * Pollinator's own half-length, its front sweeper being on the other end. It was 10.5 while the
 * default was a FRONT+BACK build, where the sweeper on the wall side counted too. The FIELD lane
 * asserts the four anchors are legal AS WRITTEN and snap to themselves byte for byte on the
 * default chassis, which is what catches this the day the default changes again.
 */
const START_CHASSIS_HALF = 7.5;
const START_SEAT_X = BB_HALF_X - START_CHASSIS_HALF;
const START_SEAT_Y = BB_HALF_Y - START_CHASSIS_HALF;
export const BB_START_POSES: readonly BbStartAnchor[] = [
  { name: 'TOP · REAR WALL', wall: 'rear', pos: { x: 34, y: START_SEAT_Y }, heading: -Math.PI / 2 },
  { name: 'BOTTOM · AUDIENCE WALL', wall: 'audience', pos: { x: 46, y: -START_SEAT_Y }, heading: Math.PI / 2 },
  // THE SIDE-WALL PAIR (owner, 2026-09-13: "come up with some default positions"). The start
  // editor offers each role two anchors, like Chain Reaction's corners. Both back onto the
  // alliance's OWN side wall (facing into the field) on either side of its LOADING ZONE
  // (y ∈ [−46.6, −23.9], G304.E): TOP at y = 45 clears the zone and F3's foot (y ∈ [20.4, 26.4]),
  // BOTTOM at y = −60 sits between the zone and the audience corner. Indices 0 and 1 are still
  // the TOP / BOTTOM defaults a 2-robot alliance spreads onto; these are the alternatives.
  { name: 'TOP · SIDE WALL', wall: 'side', pos: { x: START_SEAT_X, y: 45 }, heading: Math.PI },
  { name: 'BOTTOM · SIDE WALL', wall: 'side', pos: { x: START_SEAT_X, y: -60 }, heading: Math.PI },
];

/** how many start anchors this game offers — read by the shared per-game start-index clamp
 * (`coerceStartIndex` / `coerceSetup`) instead of DECODE's `START_POSES.length`. */
export const BB_START_POSE_COUNT = BB_START_POSES.length;

/**
 * Start ROLES are TOP / BOTTOM (which half of the start wall a robot occupies), not DECODE's
 * CLOSE / FAR. The shared `StartCat` slots carry it: close = TOP (y ≥ 0), far = BOTTOM
 * (y < 0), so a locked role limits the selector to that anchor.
 */
export const bbAnchorCat = (index: number): StartCat =>
  (BB_START_POSES[index]?.pos.y ?? 0) >= 0 ? 'close' : 'far';
export const bbDefaultIndex = (cat: StartCat): number => {
  const i = BB_START_POSES.findIndex((_, idx) => bbAnchorCat(idx) === cat);
  return i >= 0 ? i : 0;
};
/**
 * THE ROLE AS A PLAYER READS IT — TOP means the pair of anchors drawn at the TOP of the field for
 * THIS alliance.
 *
 * ⚠️ IT DEPENDS ON THE ALLIANCE, because this field is POINT-symmetric. The role slots are
 * canonical (close = the blue-frame y ≥ 0 anchors), and red's anchors are those rotated 180°, so
 * red's `close` anchors are drawn at the BOTTOM. Chain Reaction mirrors in x and never meets this;
 * labelling red by the canonical slot put "TOP · REAR WALL" on the audience wall at the bottom of
 * red's editor. Only the WORDS flip — the stored slot, the anchor indices and the 2v2 role split
 * are unchanged.
 */
export const bbRoleLabel = (cat: StartCat | undefined, alliance: Alliance = 'blue'): string => {
  if (cat !== 'close' && cat !== 'far') return '-';
  return (cat === 'close') === (alliance === 'blue') ? 'TOP' : 'BOTTOM';
};

/** an anchor's name as `alliance` sees it: its role (`bbRoleLabel`) and the wall it is really on —
 * red's rear-wall anchor is on the AUDIENCE wall once rotated, and a side wall stays a side wall. */
export function bbAnchorName(index: number, alliance: Alliance = 'blue'): string {
  const p = BB_START_POSES[index];
  if (!p) return '-';
  const wall =
    alliance === 'blue' || p.wall === 'side' ? p.wall : p.wall === 'rear' ? 'audience' : 'rear';
  return `${bbRoleLabel(bbAnchorCat(index), alliance)} · ${wall.toUpperCase()} WALL`;
}

/** a field point, optionally with a heading (radians). What `bbMirror` maps. */
export interface BbPoint {
  x: number;
  y: number;
  heading?: number;
}

/**
 * THE POINT MIRROR: `(x, y) → (−x, −y)`, `heading → heading + π`.
 *
 * The BIOBUZZ layout is POINT-SYMMETRIC (180° about the origin), NOT mirrored — red's LOADING
 * ZONE is at y > 0 and its GARDEN is the audience-left corner, and blue's are the DIAGONAL
 * opposites (`docs/biobuzz-reference.md` §2.1). The x-mirror a few lines up is a REFLECTION,
 * which is the right transform for a start anchor on a symmetric wall and the wrong one for
 * every zone on this field: reflecting a point-symmetric layout produces something internally
 * consistent and wrong, and no check inside the sim can tell the difference.
 *
 * Both live here on purpose, next to each other, so the choice is made by picking a function.
 */
export function bbMirror(p: BbPoint): BbPoint {
  return p.heading === undefined
    ? { x: -p.x, y: -p.y }
    : { x: -p.x, y: -p.y, heading: wrapAngle(p.heading + Math.PI) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PENALTIES
// ─────────────────────────────────────────────────────────────────────────────

/** inches of bumper slack for the robot-robot contact test the BIOBUZZ penalty engine
 * (`penalties.ts`) reads. That engine enforces the V1 Section 11 rules a 2D sim can see (G402,
 * G407, G410, G421); its header lists them and says why the rest are not modelled. */
export const BB_FOUL_SLOP = 1;

// ─────────────────────────────────────────────────────────────────────────────
// PRESETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every preset drives ROBOT-CENTRIC. A sweeper collects over the edge it is mounted on and a
 * turretless launcher fires over its own edge, so for most of these builds the chassis
 * heading IS the aim, and field-centric drive hides that heading from the stick. A preset
 * default, not a rule — the assist stays a per-robot setting anyone can flip.
 *
 * Shared by reference rather than repeated, so "the presets all drive the same way" stays
 * true by construction.
 */
const BB_PRESET_ASSISTS: AssistConfig = {
  fieldCentric: false,
  aimAssist: true,
  autoIntake: true,
  autoFire: false, // BIOBUZZ has no auto-fire — Aim Assist gates the driver's own fire (robot.ts `bbLaunch`)
};

/**
 * BIOBUZZ ARCHETYPE DEMOS — four builds a player would actually pick, between them covering
 * every launcher, both kinds of intake mount, a Box Tube, and — with the StarterBot's tank —
 * all five drivetrains, including the only one with two rpm sets to pick between.
 *
 * DEMOS, and they say so. The one real kit robot (the StarterBot) is defined in `presets.ts`
 * and leads the builder's list; these follow it.
 *
 * ⚠️ `BB_PRESETS[0]` MUST BE A LITERAL WITH NO `bbMech` CONTAINER. `coerce.ts` builds
 * `BB_DEFAULT_SPEC` from it and is a leaf of the spawn chokepoint, so the default robot is
 * whatever this first literal migrates to — which is why the Pollinator's Box Tube is attached
 * at the display boundary instead (`BB_DEMO_LIFT`, `presets.ts`): a launcher migrates from the
 * flat `scoreMode`/`shooterMount` mirror, a tube has no such path. Skimmer carries no container
 * either — a double turret's NECTAR-turret cell resolves from the POLLEN turret's
 * (`bbResolveMount2`), so `shooterMount: 'right'` alone coerces to a right + left pair.
 *
 * ── THE MASSES ARE DECLARED, NOT FLOORED ────────────────────────────────────
 * `bbMassLimits` says what a build has to weigh AT LEAST; these say what one like it really
 * does, which is a different number and a more useful one — four cards all sitting on their own
 * floor would tell a player nothing about the tradeoff between them. Each is its own floor plus
 * a whole number of pounds, so it is a position the mass slider can return to.
 *
 * ── THE RPMs ARE PER DRIVETRAIN ─────────────────────────────────────────────
 * `driveRpm` is normalised to a 104 mm reference wheel (`presets.ts` carries the conversion) and
 * each drivetrain has its own envelope (`rpmLimits`): tank tops out at 560 and swerve at 500,
 * both torque-biased, against 600 for the two roller drives. Every value below sits inside its
 * own range and matches the build's job — the Forager is geared for push, the Skimmer for a
 * wall-to-wall strafe. BUTTERFLY is the one that needs `tankRpm` as well: it carries two
 * independently geared wheel sets and `coerceSpec` writes that field for that drivetrain and
 * STRIPS it otherwise, so a card that declared one on any other drivetrain would not be a
 * coercer fixed point and would never highlight as selected.
 *
 * All numbers stay inside the coercer's ranges, so applying a card is a no-op through the
 * coercer and the card highlights as selected — smoke asserts this.
 */
const BB_PRESET_BUILDS: readonly RobotSpec[] = [
  {
    // THE DEFAULT, and the build that plays the whole game: a centre turret scores the HIVE from
    // anywhere on the field while the Box Tube (`BB_DEMO_LIFT`) fills a FLOWER, which is the one
    // thing nothing launched can ever do. A front sweeper feeds both. Mecanum because an
    // all-rounder wants to strafe up to a FLOWER without giving up its heading and without
    // paying for swerve, and 435 rpm because this robot spends the match crossing the field
    // rather than winning a shove.
    //   mass: 19.5 lb of hardware, built properly, is 24.5.
    name: 'Pollinator', teamName: 'Turret and Box Tube · the hive and the flowers', teamNumber: 0,
    length: 15, width: 17, intake: 'sloped', massLb: 24.5, drivetrain: 'mecanum',
    driveRpm: 435, flywheelInertia: 0, canSort: false,
    scoreMode: 'turret',
    intakeMount: 'front', shooterMount: 'center',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // the heavy collector: FRONT+BACK sweepers fill the hopper driving in either direction and a
    // FRONT dumper unloads without ever reversing into range, so the cycle has no turn and no
    // backing up in it. BUTTERFLY because that is the one drivetrain with two gearings to pick
    // between — 420 on the mecanum set to cross the field, 300 on the traction set to hold a
    // lane — and this is the only card heavy enough for the second half of that to mean
    // anything. The hopper is capped at 4 for every build, so what this offers is the cycle
    // SHAPE and the weight behind it; it carries NECTAR too.
    //   mass: the heaviest card on purpose. Weight costs cycles in this sim and buys a shove,
    //   which is the trade the card exists to offer.
    //
    // ⚠️ IT REPLACED A REAR-DUMPER TANK CALLED "HAULER" (2026-09-22), which was the weakest
    // card on the list by a distance — MEASURED at 25.8 against the StarterBot's 43.0, and the
    // StarterBot is the same drivetrain and archetype at 18 lb. It also carried Chain
    // Reaction's Hauler card verbatim, name and team line both. This build scores 63.6 over
    // eight seeds, the second best on the list.
    name: 'Forager', teamName: 'Dumper · sweeps both ends, shifts to push', teamNumber: 0,
    length: 15, width: 17, intake: 'sloped', massLb: 30.5, drivetrain: 'butterfly',
    driveRpm: 420, tankRpm: 300, flywheelInertia: 0, canSort: false,
    scoreMode: 'dumper',
    intakeMount: 'frontback', shooterMount: 'front',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // fast wall-runner: an x-drive strafes as fast as it drives, and a DOUBLE turret aims both
    // of its turrets itself — POLLEN out of the right flank, NECTAR out of the left — so it
    // scores either element on the move without ever turning. The two cells are partners
    // (grid distance 2), which is what a double turret requires.
    //   mass: two whole flywheel assemblies, and it shows.
    name: 'Skimmer', teamName: 'Double turret · both elements on the strafe', teamNumber: 0,
    length: 15, width: 16, intake: 'sloped', massLb: 27.5, drivetrain: 'xdrive',
    driveRpm: 520, flywheelInertia: 0, canSort: false,
    scoreMode: 'twinturret',
    intakeMount: 'front', shooterMount: 'right',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // the HIVE specialist, and the one build that earns a swerve: a turret aims itself, so the
    // chassis never has to face anything — which is what lets this one carry FRONT AND BACK
    // sweepers and collect driving in either direction, never turning round at either end of a
    // cycle. A single turret feeds POLLEN only and it carries no tube: it does one half of the
    // game, at the highest rate on the list.
    //   mass: four steering modules and two sweeper assemblies is a genuinely heavy chassis.
    name: 'Sniper', teamName: 'Single turret · collect driving either way', teamNumber: 0,
    length: 15, width: 17, intake: 'sloped', massLb: 26.5, drivetrain: 'swerve',
    driveRpm: 480, flywheelInertia: 0, canSort: false,
    scoreMode: 'turret',
    intakeMount: 'frontback', shooterMount: 'center',
    assists: BB_PRESET_ASSISTS,
  },
] as const;

/**
 * The shipped builds, with MASS and HOPPER derived rather than typed out.
 *
 * Both are FUNCTIONS of the build — the mass floor of a drivetrain × mechanism, and
 * the capacity of a footprint × archetype × mount — so a hard-coded number would quietly stop
 * being "the minimum" / "the maximum" the moment any of those constants moved, and a preset
 * whose value the coercer then clamps is a card that stops highlighting as selected.
 */
export const BB_PRESETS: readonly RobotSpec[] = BB_PRESET_BUILDS.map((s) => ({
  ...s,
  massLb: Math.max(s.massLb, bbMassLimits(s).min),
  ballStorage: bbStorageMax(s),
}));

/** the default mount for a build that arrives without one (re-exported so the builder and the
 * coercer read the same constant the leaf module defines). */
export { BB_DEFAULT_INTAKE_MOUNT };

// ─────────────────────────────────────────────────────────────────────────────
// 3D PHYSICS (Day 1 seam, `docs/biobuzz/plan-3d.md`) — everything below is new for the 3D
// physics port and is not read by the 2D pipeline at all. NOT APPROX: R102/R105.A already
// print all three chassis dimensions (see `BB_PRISM`'s header above for the two horizontal
// ones); this is the first place BIOBUZZ names the VERTICAL one.
// ─────────────────────────────────────────────────────────────────────────────

/** `RobotSpec.heightIn` floor (in) — well under any real build; a robot has to be tall enough
 * to hold a drivetrain and a hopper at all. */
export const BB3_HEIGHT_MIN = 12;
/**
 * `RobotSpec.heightIn` default (in) when absent.
 *
 * ⚠️ **14, NOT 18** (owner, 2026-09-18, off the 3D robot playtest: "robot is way too tall for no
 * apparent reason"). 18 was chosen as "a plausible mid-size chassis" before anything drew a robot
 * in three dimensions, and it happens to be R102's stow cube — but nothing a preset build CARRIES
 * needs it. The drivetrain is `BB_DECK_Z` 4.6 in, a dumper releases at `BB_LAUNCH_Z0` = 10 and a
 * turret between 7.55 and 9.63 depending on its elevation (`bbMuzzleLocal`, the hood rebuild of
 * 2026-09-19 — a turret's release came DOWN, so nothing here got tighter), and the tallest
 * mechanism geometry on any preset tops out around 12.1 in. 14 clears the
 * whole shooter with an inch or two of air, stays legal at stow (`BB3_STOW_MAX` is 18, so a
 * default build still folds inside the cube by construction) and still drives under the HIVE
 * (`BB_HIVE_BOTTOM_Z` 31.98). It is the 3D COLLIDER height for a spec that names none, so it
 * matters to the sim, not to the picture — which is why it is a number here and not a mast.
 */
export const BB3_HEIGHT_DEFAULT = 14;
/**
 * `RobotSpec.heightIn` ceiling (in), the robot's TOTAL height — the builder's slider and the
 * coercer both stop here, so they can never disagree.
 *
 * ⚠️ **18, NOT R105.A's 29** (owner, 2026-09-24: "height should not go up that high … total can
 * be like 18 inches"). The manual allows 29 in fully expanded, but no mechanism here stands
 * above the dumper's 12.85, so a 29-in dial described a robot nobody could see. 18 is also
 * R102's starting cube (`BB3_STOW_MAX`), so the builder no longer offers a stow height.
 */
export const BB3_HEIGHT_MAX = 18;

// ─────────────────────────────────────────────────────────────────────────────
// 3D PHYSICS — DAY 1 SIM CONSTANTS (`docs/biobuzz/plan-3d.md` §10/§13.1), appended below the
// height section above. Every value not cited to the manual is `APPROX` — CAD colliders and a
// weighed element set replace these on a later day; nothing here is read by the 2D pipeline.
//
// NOTE: this file does NOT redeclare `BB_HIVE_TILT_DEG` (30°, already above, under HIVE
// STRUCTURE) for the tray's rest tilt — `sim3d/hive3d.ts` imports that one constant rather than
// carrying a second copy of the same number under a `BB3_` name.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Day 1's kinematic tray vs. Day 2's DYNAMIC SEE-SAW on a revolute joint (plan §3.6, §11).
 *
 * ✅ **STILL TRUE — 2026-09-19, RELEASE PREDICATE REPLACED, NOT THE TRAY.** The tray body, the
 * joint, the CAD geometry, the damping-fitted ~4 s swing, the physical spill and G409's
 * `bb.spill` tag all work and all depend on this being `true`.
 *
 * ⚠️ **WHAT CHANGED: THE TRIGGER IS NOW THE TABLE, NOT A TORQUE.** A torque threshold was fit
 * against the Event Field Setup Guide's §12.3 rows and looked right at one packing per row —
 * but one COUNT does not determine one TORQUE. MEASURED at the fitted hold (5915): 8 POLLEN in
 * the same cell spans torque 4644 (piled at the back wall) to 9355 (a two-wide line), and 7
 * POLLEN spans 4204 to 7769 — the two counts' torque ranges overlap almost entirely, so no
 * `BB3_HIVE_DETENT`/`BB3_HIVE_BALLAST` pair can separate them. Worse, the guide's own rows were
 * violated in BOTH directions under the torque trigger: 8 POLLEN piled at the back wall did not
 * tip, and 7 POLLEN in a two-wide line did. `sim3d/hive3d.ts`'s `hiveDetentHold` now releases on
 * `hiveWillTip(hiveLoad(hives[a].contents, kindOf))` — the SAME `BB_TIP_POLLEN` list the HUD
 * counts — so the HUD's "0 more to tip" and the tray's own release agree BY CONSTRUCTION on every
 * row and every packing, which a torque number could not promise. `BB3_HIVE_DETENT` is
 * unchanged and still reported (see its header) — it is a diagnostic now, not the release.
 *
 * Setting it back to `false` is **NOT** "a one-word change that stays proven" (that used to be
 * true and no longer is): `bb.spill` — G409's whole tag — is written in exactly one place,
 * `hiveDynamicTick`, on the DYNAMIC path only. The kinematic path never writes it, so flipping
 * this word silently turns G409 off in 3D. If it is ever flipped, the HIVE3D lane's four G409
 * blocks must move out from under `if (BB3_HIVE_DYNAMIC)` first, or the lane stays green while
 * G409 stops firing.
 */
export const BB3_HIVE_DYNAMIC = true;

/**
 * CAD-DERIVED FIELD COLLIDERS (`docs/biobuzz/plan-3d.md` §8) vs. the Day 1 constants-built
 * geometry, for the STATICS (walls' inner face/height, the hive frame legs, the flower supports)
 * and the hive TRAY (`sim3d/bodies.ts`'s `buildHiveTray3d`/`hiveCellLocalBox`).
 *
 * `true` here is the switch-over: `sim3d/bodies.ts` reads `public/models/biobuzz/field-
 * colliders.json` (via `sim3d/fieldColliders.ts`, generated into `fieldColliders.gen.ts` by
 * `npm run field-cad`) when this is `true`, falling back to the analytic box/bar/foot geometry
 * per part whenever the CAD set is missing that part (an empty hull list, an absent static) —
 * so flipping this to `false` (or the CAD files ever being pulled per their own README's
 * one-commit-revert plan) restores the Day 1 geometry exactly, with no other code change.
 */
export const BB3_FIELD_COLLIDERS = true;

/** the HIVE pivot's height above the tiles (in) — CAD (`fieldDims.gen.ts`, `hive.pivotZ`
 * 43.9497). The manual's 43.95 was exact. */
export const BB3_HIVE_PIVOT_Z = HIVE.PIVOT_Z;

/** distance from the pivot to a CELL's centre, ALONG THE BAR (in, true length, not the plan
 * projection `BB_HIVE_CELL_DY` already carries) — CAD, the midpoint of the measured cell's own
 * near and far faces. `BB3_HIVE_ARM · cos(BB_HIVE_TILT_DEG)` IS `BB_HIVE_CELL_DY`, by
 * construction now rather than by a pair of hand-typed numbers agreeing. Was 15.44. */
export const BB3_HIVE_ARM = HIVE.ARM;

/** a CELL's TRUE depth along the bar (in) — CAD (far − near over the four measured cells);
 * `BB_HIVE_CELL_LEN` is this number's plan projection at 30°. Was 12.04. */
export const BB3_HIVE_CELL_LEN = HIVE.CELL_D;

/** the CELL assembly end to end, TRUE length along the bar (in) — CAD (2 × the far face);
 * `BB_HIVE_LEN` is this number's plan projection at 30°. Was 42.91. */
export const BB3_HIVE_LEN = HIVE.LEN;

/**
 * one CELL's interior box, in the tray-local frame `sim3d/bodies.ts` defines (`w` across the
 * bar / world x, `d` along the bar, `h` floor to open top).
 *
 * CAD (`fieldDims.gen.ts`), no longer APPROX: the three numbers are the four measured cells'
 * mean width, depth and floor-to-roof height. The Day 1 guesses were `{20, 14, 12.04}` — the
 * depth was a true length "rounded up to a plausible box depth" and was 2.25 in too deep, and
 * the height reused the DEPTH figure and was 1.96 in too short.
 */
export const BB3_HIVE_CELL = { w: HIVE.CELL_W, d: HIVE.CELL_D, h: HIVE.CELL_H };

/** cell wall thickness (in) — APPROX, CAD settles it; used for the five-box kinematic tray
 * (floor, back, two sides, divider). */
export const BB3_HIVE_CELL_WALL = 0.25;

/** perimeter wall collider height (in) — APPROX, tall enough that nothing legal on this field
 * clears it (R105.A lets a robot stand 29 in). */
export const BB3_WALL_H = 40;

/** one element's mass (lb) — APPROX until a set is weighed (owner action; plan §3.6). */
export const BB3_ELEMENT_MASS = 0.2;

/** NECTAR's mass as a multiple of POLLEN's — APPROX (plan §3.6: "the field guide says three
 * pollen plus three nectar mass less than eight pollen", which rules out volume scaling). */
export const BB3_NECTAR_MASS_RATIO = 1.6;

/** ground element friction / restitution / angular (roll) damping — APPROX, tuned Day 4+.
 * `_ROLL_DAMP` is `setAngularDamping` on the sphere body: a free rolling sphere has no analogue
 * of the 2D artifact world's `BALL_ROLL_FRICTION` velocity-pass (Rapier's own rolling contact
 * would otherwise let a struck element roll forever), so this is what brings one to rest. */
export const BB3_ELEMENT_FRICTION = 0.6;
/**
 * ⚠️ **IT IS THE ELEMENT/TILE PAIR NOW, NOT HALF OF IT** (owner report 2026-09-19: "in real life
 * the balls bounce and disperse a lot more after the hive tips and it hits the field tiles").
 *
 * The tiles carry a MULTIPLY rule at the identity (`sim3d/bodies.ts` `TILE_RESTITUTION`), so this
 * number IS what an element bounces off the floor at, instead of being averaged with a floor
 * coefficient into `(0.45 + 0.05)/2 = 0.25`. A hard plastic ball on FTC foam is ~0.5–0.6; 0.55 is
 * the middle of that band. Still APPROX — no element has been dropped on a real tile with an
 * instrument — but the band is a real one rather than a number sized to a screenshot.
 *
 * MEASURED, a staged 8-POLLEN tip, the elements arriving at ~160 in/s off the ~30-in tray:
 * first rebound 1.0–2.1 in BEFORE, 8.6–11.0 in AFTER, and the spread about the pile's own
 * centroid went from a 17.8-in cluster to a 33.9-in one — inside the 2D pipeline's own 28–32 in,
 * which is what keeps a record set on one solve comparable with a record set on the other.
 *
 * It is also the element/element coefficient (both sides Average, so `(0.55+0.55)/2`), which was
 * 0.45 and is part of why a landing pile now scatters instead of pooling. The element/TRAY pair
 * is UNCHANGED — the tray's `Min` rule outranks Average and still hands back the tray's own 0/0.15,
 * which is what keeps a shot in the cell.
 */
export const BB3_ELEMENT_RESTITUTION = 0.55;
export const BB3_ELEMENT_ROLL_DAMP = 0.4;

/**
 * NEW. Contact stiffness (`contact_natural_frequency`, Hz) for the whole BIOBUZZ 3D world
 * (`sim3d/engineImpl.ts` and `sim3d/predict.ts` — BOTH must read this constant, or the client's
 * predicted world and the authoritative one solve contacts at different stiffness and reconcile-
 * snap on every landed shot). Was: absent — the 3D world inherited the shared `PHYS_CONTACT_FREQ`
 * (12 Hz, `src/config.ts`), which is tuned for the 2D DECODE robot world and is explicitly NOT
 * higher there because 15 Hz broke the classifier-jitter ratchet and 25 Hz broke two G408
 * possession checks and the wall-ram torque bound — none of which exists in this world, so the
 * shared constant cannot move and BIOBUZZ 3D needs its own.
 *
 * MEASURED, two independent overlap problems the same stiffness governs, both improving with
 * frequency per the closed-form soft-contact sag `g/(2·π·f)²`:
 *  • a settled element's penetration into the HIVE cell floor: 0.061–0.067 in at 12 Hz, 0.025–
 *    0.030 in at 25 Hz (closed form 0.068 / 0.0157 in — the measurement is the model).
 *  • a stacked POLLEN column's worst pollen-pollen overlap in a FLOWER tube (4-stack / 8-stack,
 *    the FLOWER's own POLLEN capacity): 12→0.406/0.948 in, 20→0.146/0.341, 30→0.065/0.152,
 *    45→0.029/0.068, 60→0.016/0.038 (bare-Rapier control).
 * 30 is the first value where an 8-high FLOWER column overlaps by less than a 16th of a diameter,
 * and it is 1.5× the shared robot-world value rather than 4×, which keeps robot-robot/robot-wall
 * contacts near where the drive-parity checks measured them. It also improves the HIVE floor case
 * beyond what 25 Hz gave it (closed-form sag at 30 Hz ≈ 0.0109 in, better than 25 Hz's 0.0157),
 * so one value serves both measurements — a separate diagnosis proposed 25 Hz (parity with the
 * 2D pipeline's `PHYS_BALL_CONTACT_FREQ`) for the HIVE case alone; 30 Hz is taken instead because
 * it is evidenced across both hive-floor and flower-stack measurements and dominates 25 Hz on
 * both. `normalizedAllowedLinearError` and `numSolverIterations` were swept and ruled out as
 * levers for either problem (bit-identical / very slightly worse) — see `sim3d/engineImpl.ts`.
 */
export const BB3_CONTACT_FREQ = 30;

/** CCD switches on above this speed (in/s) — APPROX, sized so a full-speed launch
 * (`BB_LAUNCH_SPEED_MAX` 260) never tunnels a 0.25-in cell wall. */
export const BB3_CCD_SPEED = 60;

/** how close an element's BOTTOM must be to the tiles (in) to count as rolling ON them —
 * the floor-contact test `groundRoll3d` applies the shared Coulomb rolling law through. Above
 * it the element is on structure or in the air and gets no rolling law at all. APPROX: a hair
 * over the readback rounding and the solver's own resting penetration. */
export const BB3_ROLL_FLOOR_Z = 0.25;

/**
 * THE ROLLING DECELERATION `groundRoll3d` ADDS (in/s²) — and it is DELIBERATELY NOT the 2D
 * pipeline's `BALL_ROLL_FRICTION` (32), because in 3D it is not the whole of the law.
 *
 * A 2D ground artifact is solved in a plane with no gravity and no floor, so `stepGroundBall`'s
 * 32 in/s² IS its entire rolling resistance. A 3D element is a real sphere resting on a real
 * floor with `BB3_ELEMENT_FRICTION` and `BB3_ELEMENT_ROLL_DAMP` already taking speed out of it
 * every step; adding 32 on top stopped it in half the distance. Measured roll-out at 20/40/60
 * in/s — 2D 6.9 / 28.2 / 63.7 in against 3D 3.8 / 15.1 / 33.8 at a deceleration of 32, and
 * 7.9 / 29.3 / 61.2 at 12, which is inside 15% of 2D across the range. The SIM3D lane asserts
 * that agreement rather than the constant, so re-tuning Rapier's own element friction or roll
 * damping fails there rather than silently drifting the two pipelines apart.
 */
export const BB3_ROLL_DECEL = 12;

/** an element counts as AT REST below this speed (in/s), for `BB3_REST_TICKS` consecutive
 * ticks — `sim3d/derive.ts`'s REST SNAP and `sim3d/engineImpl.ts`'s off-floor twin. APPROX.
 *
 * ⚠️ It is NOT the cell-membership test any more (2026-09-19) — see `BB3_CELL_SEAT_DEPTH`. */
export const BB3_REST_SPEED = 2;
export const BB3_REST_TICKS = 6;

/**
 * HOW FAR BELOW A CELL'S RIM AN ELEMENT'S CENTRE HAS TO BE BEFORE THE CELL COUNTS IT (in), in
 * the tray's own tilted frame. `sim3d/derive.ts`'s cell-membership test, and the whole of it:
 * no rest requirement, no dwell.
 *
 * ⚠️ **IT REPLACED A REST TIMER, AND THE REST TIMER WAS THE OWNER'S BUG** (2026-09-19: "a lot of
 * delay registering when the balls land in the hive... a significant amount of lengthened tipping
 * time due to the registration time"). Membership used to need `BB3_REST_TICKS` of stillness,
 * which is a proxy for "landed in it" that costs whatever the element's own settling costs.
 * MEASURED over 1,500 randomized arrivals at a real cell, entry of the centre to
 * `hives[a].contents`: **mean 95 ticks (1,588 ms), p50 75, p90 205, max 264**, and one arrival in
 * a hundred never registered at all inside five seconds. A real HIVE is a see-saw: an element's
 * weight is on the tray the moment it is in the tray, and it does not wait until it has stopped
 * rolling.
 *
 * **THE ONLY THING THE REST GATE WAS REALLY BUYING** was a filter against a shot that GRAZES the
 * open top of the cell and carries on — "a shot crossing the mouth is not yet in it". That is a
 * real case and the same sweep measured it exactly: of 209 arrivals that put a centre inside the
 * interior, 92 left again, and **every one of them stayed in the top 2.75 in of a 14-in cell**.
 * None entered the mouth and came back out; the cell is a box with one opening and what gets
 * properly inside it stays. So DEPTH separates the two populations outright, where "has it
 * stopped moving" only separates them by waiting:
 *
 *   deepest any grazing shot ever reached   2.75 in below the rim
 *   ─────────── 3.5, here ───────────
 *   shallowest a landed element ever RESTS  4.33 in below the rim  (a 4-high stacked pile;
 *                                                                   an ordinary load rests 10+)
 *
 * 0.75 in of margin below, 0.83 in above, and at this value the sweep records **0 grazes counted
 * and 0 landed shots missed**. What it costs is nothing: entry to depth is **mean 0.2 ticks,
 * max 7** across the same 1,500 arrivals, against the 95 the rest gate cost.
 *
 * Re-measure it (`scripts/smoke-biobuzz/hive3d.ts` prints both bounds) if the cell box, the
 * element radii or the tray restitution move — it is a window, not a threshold, and it is the
 * only tuned number in the membership test.
 */
export const BB3_CELL_SEAT_DEPTH = 3.5;

/* `BB3_CAPTURE_TICKS` (a 3-tick consecutive-overlap dwell before a 3D capture) is GONE. The
 * roller model (`bbIntakeAct`) is shared by both backends now and does that job better and in
 * both of them: a fast pass-through is refused by `BB_INTAKE_CROSS_MAX` rather than by a dwell,
 * and the delay before a swallow is the feed cadence plus the transit to the throat. A constant
 * with no reader is a number documenting an intention nothing implements. */

/** the intake's reach above the tiles (in) — an element whose BOTTOM is below this height,
 * inside a mouth rect, is eligible for capture. APPROX: a sweeper roller sits low enough to
 * catch a resting element and a shallow bounce, not a lobbed one passing overhead. */
export const BB3_INTAKE_Z = 5;

/**
 * THE INTAKE MOUTH'S SLOT HEIGHT (in) — how far up the 3D chassis compound's mouth pocket is
 * OPEN (`chassis3dShapes`, `sim3d/bodies.ts`). One NECTAR diameter, the tallest element there
 * is, so every element rolls in under the roller bar and nothing else does: a wall, a robot,
 * the HIVE and a FLOWER all meet the lintel above it at exactly the distance the old
 * single-cuboid collider put them at.
 */
export const BB3_MOUTH_SLOT_Z = 2 * BB_NECTAR_R;

// ─────────────────────────────────────────────────────────────────────────────
// THE DRAWN HEIGHT PROFILE — what the 3D chassis compound is TALL AT
//
// ⚠️ **A BIOBUZZ CHASSIS USED TO BE A FLOOR-TO-`heightIn` PRISM OVER ITS WHOLE FOOTPRINT**, and
// that is the owner's invisible corner, sixth report (2026-09-21): *"try putting the front of the
// robot against the center of the horizontal beam, and strafe, from under the hive. You will
// suddenly turn because you hit something invisible."* MEASURED (`scratch/beamstrafe.ts`): at the
// jam the ONLY non-floor, non-flange contact is the hive's A-FRAME LEG, whose underside at the
// chassis' −y edge is at z ≈ 14.1 — exactly the top of a default 14-in prism, and 8.8 in above
// anything that is DRAWN there. The five earlier passes all looked at the FIELD's geometry; the
// invisible thing was the ROBOT.
//
// The numbers below are the drawn robot, measured off the built meshes' own vertices over every
// archetype the builder can make (three launchers × nine mounts, three intakes × four mounts,
// five drivetrains, the height slider's whole range, the chassis size envelope) — see
// `scratch/drawnheight.ts` / `scratch/mechenv.ts`. The RENDER lane re-measures them against
// `buildRobotGroup` and fails if the picture moves, which is the same bargain
// `BB_PLATE_T_DUP` makes in `sim3d/bodies.ts`: `sim3d/` may not import `scene/`, so the
// agreement is a CHECK rather than an import.
//
// ⚠️ **`heightIn` IS A CAP NOW, NOT AN EXTRUSION** — see `bbMechEnvelopes` below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DRAWN CHASSIS' OWN TOP (in) — the height the LOW BODY (frame, intake side arms, lintel and
 * the pocket filler) is built to.
 *
 * MEASURED, every archetype: the frame's top cap `BB_DECK_Z + 0.2` = **4.80**, the nose **5.10**,
 * the sweeper roller **5.25**, the intake arm's diagonal **5.26** — and a side roller's own wheel
 * tops out at `BB_SIDE_ROLLER_Z + BB_SIDE_ROLLER_H/2` = 2.50, well under. 5.3 is the smallest
 * round number above all of them, i.e. the drawn chassis with 0.04 in of air.
 *
 * ⚠️ **IT MUST STAY ABOVE THE FLOWER'S MID PLATE** (z 3.904…5.254, `scratch/srgeom.ts`), which is
 * the surface a chassis stops its whole front face against at a FLOWER. A low body that ended at
 * the deck (4.80) would still meet it — the plate's band starts at 3.90 — but a low body under
 * 3.90 would drive straight under the flower and the retrieval geometry would move. Nothing here
 * is allowed to go below `BB3_MOUTH_SLOT_Z` for the same reason.
 */
export const BB3_CHASSIS_TOP_Z = 5.3;

/** the drawn top of a POLLEN turret head, and the radius it sweeps about its own ring centre.
 * MEASURED 11.315 / 5.038 over all nine mounts and the whole chassis-size envelope — the head is
 * built from `BB_FLYWHEEL_R` and the hood constants, so neither figure scales with the chassis. */
export const BB3_TURRET_TOP_Z = 11.35;
export const BB3_TURRET_R = 5.05;
/** the same pair for a DOUBLE turret's second head, which is built to the NECTAR dimension set
 * (`bbTurretFor`) and is therefore taller and wider. MEASURED 12.115 / 5.558. */
export const BB3_NECTAR_TURRET_TOP_Z = 12.15;
export const BB3_NECTAR_TURRET_R = 5.6;

/**
 * THE DUMPER'S DRAWN ENVELOPE, in its own edge frame (`u` outward, `v` lateral). Every number is
 * `buildDumper`'s own, and the RENDER lane checks the two agree to 0.01 in on every edge and
 * chassis size: the shaft stands `min(8, 0.8·dist)` back from the edge with radius 0.34, the lip
 * ends 0.7 in short of it and is 0.6 in deep, and the bucket is `0.86·span` half-wide plus a
 * 0.28-in side wall. MEASURED top **12.80**, bottom `BB_DECK_Z`.
 *
 * ⚠️ **AT REST, NOT MID-THROW.** The tray swings up about its shaft when it fires
 * (`DUMP_THROW_ANGLE`), which takes the lip to ≈14.3 in for ~0.3 s — taller than the prism this
 * replaces ever was, and taller than `BB3_HEIGHT_DEFAULT`. Nothing on the field lives in that
 * band over a robot's own deck (the lowest overhead structure is `BB_HIVE_BOTTOM_Z`, 31.98), so
 * the throw is a drawn part outside the collider rather than a collider outside the drawing —
 * the harmless direction, and the one the old prism was also on.
 */
export const BB3_DUMPER_TOP_Z = 12.85;
export const BB3_DUMPER_PIVOT_BACK = 8;
export const BB3_DUMPER_PIVOT_FRAC = 0.8;
export const BB3_DUMPER_SHAFT_R = 0.34;
export const BB3_DUMPER_LIP_BACK = 0.4;
export const BB3_DUMPER_SPAN_FRAC = 0.86;
export const BB3_DUMPER_WALL_T = 0.14;

/**
 * one STANDING mechanism's drawn envelope in the robot frame (+x forward, +y left), for
 * `chassis3dShapes` to turn into one tall collider. A turret is a CYLINDER because it aims
 * itself: the collider is built once per deploy edge and the head yaws every tick, so the disc it
 * sweeps IS its drawn geometry — the same bargain `bbRampSwingShapes` makes for the ramp.
 *
 * ⚠️ **THE DUMPER'S BOX IS ALREADY AXIS-ALIGNED IN THE ROBOT FRAME, AND CARRIES NO ROTATION.**
 * Every `EDGE_ANGLE` is a multiple of 90°, so a flank mount simply swaps `hx`/`hy` — which is
 * what lets `birthClear`'s `boxGap` (which ignores rotation, `engineImpl.ts`) stay a conservative
 * over-approximation rather than a wrong one.
 */
export interface BbMechEnvelope {
  /** the mechanism's own name, for the smoke lanes' own reporting */
  what: 'turret' | 'nectarTurret' | 'dumper' | 'liftBase' | 'liftColumn';
  cx: number;
  cy: number;
  /** a cylinder of this radius about `(cx, cy)`, or `undefined` for the box below */
  r?: number;
  hx?: number;
  hy?: number;
  /** the drawn top above the tiles */
  top: number;
  /** where the solid STARTS above the tiles, when it is not the deck — the Box Tube's column
   * stands on its own base box (`bbBoxTubeEnvelopes`) */
  bottom?: number;
  /** a box too small on top to carry a ball: built ROUNDED (`BB3_LIFT_EDGE_R`), which
   * `groundRoll3d` counts as a NARROW part, so an element that lands on it rolls off rather than
   * balancing on a tube top — the rule a turret's cylinder already follows */
  narrow?: boolean;
}

/** the rounding of a Box Tube tower's collider boxes (in) — see `BbMechEnvelope.narrow` */
export const BB3_LIFT_EDGE_R = 0.2;

/**
 * EVERY STANDING MECHANISM THIS BUILD DRAWS, with its own footprint and its own drawn top.
 *
 * ⚠️ **AND THIS IS WHERE `spec.heightIn` STOPPED BEING AN EXTRUSION.** It used to be the height
 * of a prism over the WHOLE footprint; it is a CAP now — `top` is never above it — so the rules
 * that read it are untouched (`bbDeployedHeightIn`/`bbStowHeightIn`/`bbStowLegal` are spec rules
 * and never looked at a collider; `bbHeightNow` still names the height the compound is built to,
 * and the R102 deploy edge still rebuilds on it) and what changes is only WHERE the robot is that
 * tall. It bites exactly once in the whole envelope: a 12-in declared robot with a DUMPER, whose
 * drawn bucket is 12.80.
 *
 * ⚠️ **THE DIAL PROMISES A HEIGHT THE PICTURE DOES NOT BUILD, AND THE PICTURE WINS.** The drawn
 * robot tops out at 11.31 (turret) / 12.11 (double) / 12.80 (dumper) whatever the slider says —
 * the builder shows the declared height as a DASHED ENVELOPE (`buildHeightEnvelope`,
 * `renderPreview.ts`) precisely because no mesh stands that tall, and the match draws nothing at
 * all. Extruding a declared 29 in over the turret's own footprint would have kept 17 in of
 * invisible column exactly where the owner's report puts it (the A-frame leg's underside crosses
 * 11–14 in right under the hive), so the collider follows the drawing. MEASURED, that is the ONLY
 * behaviour a declared height still had: of 69 fixed colliders, everything a robot can reach
 * above the deck is VERTICAL over it (the walls, the flower columns 4.25…21.25, the hive frame)
 * except the four sloping A-FRAME LEGS and a 0.9-in rim on each flower's top plate — so
 * "declared taller ⇒ stopped sooner" only ever meant "gets less far under the hive", and it was
 * never drawn.
 */
export function bbMechEnvelopes(spec: RobotSpec, heightIn: number): BbMechEnvelope[] {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const cap = (z: number): number => Math.min(z, heightIn);
  const out: BbMechEnvelope[] = [];
  if (launcher.kind === 'dumper') {
    const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
    const { dist, span } = edgeGeom(spec, edge);
    const pivot = dist - Math.min(BB3_DUMPER_PIVOT_BACK, dist * BB3_DUMPER_PIVOT_FRAC);
    const u0 = pivot - BB3_DUMPER_SHAFT_R;
    const u1 = dist - BB3_DUMPER_LIP_BACK;
    const vHalf = span * BB3_DUMPER_SPAN_FRAC + BB3_DUMPER_WALL_T;
    const a = EDGE_ANGLE[edge];
    const uMid = (u0 + u1) / 2;
    const uHalf = (u1 - u0) / 2;
    const end = edge === 'front' || edge === 'back';
    out.push({
      what: 'dumper',
      cx: uMid * dcos(a),
      cy: uMid * dsin(a),
      hx: end ? uHalf : vHalf,
      hy: end ? vHalf : uHalf,
      top: cap(BB3_DUMPER_TOP_Z),
    });
    out.push(...bbBoxTubeEnvelopes(spec, heightIn));
    return out;
  }
  const t0 = turretLocal(spec, launcher.mount);
  out.push({ what: 'turret', cx: t0.x, cy: t0.y, r: BB3_TURRET_R, top: cap(BB3_TURRET_TOP_Z) });
  if (launcher.kind === 'twinturret') {
    const m2 = launcher.mount2 ?? bbResolveMount2(launcher.mount, undefined);
    const t1 = turretLocal(spec, m2);
    out.push({ what: 'nectarTurret', cx: t1.x, cy: t1.y, r: BB3_NECTAR_TURRET_R, top: cap(BB3_NECTAR_TURRET_TOP_Z) });
  }
  out.push(...bbBoxTubeEnvelopes(spec, heightIn));
  return out;
}

/**
 * ⚠️ **THE CHASSIS EDGE BREAK (in)** — every box of the 3D chassis compound is SHRUNK by this
 * on every axis and given a CONTACT SKIN of this, which Rapier defines as an outward skin of
 * that width, so every FLAT FACE stays in exactly the plane it was in and only the EDGES are
 * broken (`chassisBoxDesc`, `sim3d/bodies.ts`, whose header has the A/B that chose a skin over
 * a `roundCuboid`). APPROX: a measured threshold, not a dimension.
 *
 * ⚠️ **THE OWNER'S "I can get stuck on a corner" IS A GRAZE, NOT A HEAD-ON STOP**, and it is
 * NOT the intake compound. Measured by driving a robot at full stick past the LEFT FLOWER's
 * support column with its flank a given overlap past the column's field-side face, travel over
 * 4 s against the same 4 s unobstructed:
 *
 *   largest overlap it still slides past (>=90% of a free run)  shipped   with this
 *     the intake compound (frame + arms + lintel)                 0.2 in     0.4 in
 *     one `robotExtents` cuboid (the FULL predictor's shape)      0.2 in     0.4 in
 *     the bare chassis box, no intake reach at all                0.2 in      —
 *     the 2D pipeline, same manoeuvre                             1.0 in      —
 *
 * The compound and the single cuboid catch at the SAME overlap to two decimals, so the arms and
 * the lintel are not what hooks — a square chassis corner in the 3D solve is. Past the
 * threshold the robot does not merely slow: it keeps **0.32** of a free run, yaws **107°** about
 * the corner and crawls at 8 in/s, which is the report. It is still escapable (reverse frees it
 * in 24 in, a strafe in 76), so it is lost momentum and a spin-out, not a lock.
 *
 * Three other suspects were measured and RULED OUT, each by making it not matter:
 *   - FRICTION. The statics' µ set to 0 leaves the threshold at 0.25 in (yaw 77° instead of
 *     107°), so the yaw comes from the NORMAL impulse at a corner far ahead of the centre of
 *     mass, not from Coulomb drag.
 *   - CONTACT STIFFNESS. `contact_natural_frequency` at 30 (shipped), 20 and the 2D robot
 *     world's 12 give bit-identical rows.
 *   - THE FIELD. Rebuilt with `__setFieldCollidersOverrideForTests(false)`, i.e. the 3D solve
 *     against the 2D pipeline's OWN flower-foot box, it slides past 0.3 in where the 2D
 *     pipeline manages 1.0 — same geometry, both solvers, so what is left is the solve.
 *
 * **0.125 IS WHERE THE BENEFIT SATURATES, AND THE ARM IS WHAT CAPS IT.** Swept against three
 * different corners — the FLOWER column, a parked ROBOT's corner, the HIVE frame bar's end —
 * with the invariants measured at every step:
 *
 *   r      flower  robot  hive   yaw@hook   flat-wall delta   start drift   no-climb max z
 *   0      0.2 in  2.4    0.6    105 deg    —                 0.0000        0.0000
 *   0.125  0.4 in  2.4    0.6    101 deg    0.00000/0.00000   0.0000        0.0000
 *   0.25   0.4 in  2.4    0.6    100 deg    0.00000/0.00000   0.0000        0.0000
 *   0.375  0.4 in  2.4    0.6     98 deg    0.00000/0.00000   0.0000        0.0000
 *   0.5    0.4 in  2.4    0.6     97 deg    0.00000/0.00000   0.0000        0.0000
 *   0.75   0.4 in  2.4    0.6     94 deg    0.00000/0.00000   0.0000        0.0000
 *   1.0    0.4 in  2.4    0.6     92 deg    0.00000/0.00010   0.0000        0.0000
 *
 * Nothing above 0.125 moves a single graze number, and capture is flat across the whole sweep
 * (a six-element cluster 12/18, a strafe past a line 4/4, an element riding the mouth's lateral
 * edge 3/4, identical at r = 0, 0.125, 0.25, 0.5 and 1.0), so the smallest radius that buys the
 * whole effect is taken.
 *
 * ⚠️ **AND THE CEILING IS THE ARM, NOT THE CLAMP.** The radius is clamped per box to
 * `BB3_INTAKE_CORNER_CLAMP × min(hx, hy, hz)` so no core can go degenerate, and the arm is
 * `INTAKE_RAIL_T` = 0.5 in thick (half-extent 0.25), so its own fillet can never exceed 0.25 in
 * by geometry. Rebuild the compound WITHOUT the arms and the limit keeps climbing with r —
 * 0.4 / 0.5 / 0.7 / 1.2 in at r = 0.125 / 0.25 / 0.5 / 1.0 — because the frame box's half-extent
 * is 7.5 and can carry any of them; with the arms present it is 0.4 at every radius. A right
 * CYLINDER of the chassis width slides past EVERY overlap out to 1.6 in. So a bigger break is
 * not available to this mouth without thickening the arm, and that is `bbRobotSolids`' geometry
 * and the 2D pipeline's.
 *
 * ⚠️ **NOTHING ANY INVARIANT MEASURES MOVES.** A skinned box is the Minkowski sum of a
 * smaller box with a ball: the six faces sit in their original planes, so flat-wall rest
 * distance, wall-flush starts and `startLegal` are untouched. Only the corners pull in — a
 * two-edge (vertical) corner by `(1 − 1/√2)r` = **0.037 in** and a three-edge vertex by
 * `(1 − 1/√3)r` = **0.053 in**, both under the ≈0.1 in of resting penetration the solver allows
 * anyway (`PHYS_ALLOWED_ERROR` × `PHYS_LENGTH_UNIT`).
 *
 * ⚠️ **THERE IS NO SEGMENT COUNT, AND THAT IS THE ANSWER TO THE OPEN QUESTION, NOT A SHORTCUT.**
 * The previous pass at this left a note that "a 45-degree chamfer still has lockable edges (and
 * locks harder at depth) — try a multi-segment arc". A swept ball IS the arc: no facets, no
 * segment count to pick, so a chamfer's own edges never exist to be caught on.
 */
export const BB3_INTAKE_CORNER_R = 0.125;

/**
 * How much of a chassis box's SMALLEST half-extent the edge break above may consume. APPROX.
 *
 * A `roundCuboid`'s core is the box shrunk by `r` on every axis, and a core half-extent at or
 * below zero is a collider Rapier will not build — the same reason `chassis3dShapes` already
 * clamps the arm thickness. 0.8 leaves a fifth of the thinnest box as core (the arm: 0.25 →
 * 0.05 in) and is not a tuned number in its own right: every radius from 0.125 to 0.375 gives
 * the same measured threshold under it, so it binds only as a floor on the core.
 */
export const BB3_INTAKE_CORNER_CLAMP = 0.8;


/**
 * ⚠️ **HOW FAR CLEAR OF A CHASSIS SOLID A FLIGHT BODY IS BORN (in)** — `syncElement`
 * (`sim3d/engineImpl.ts`), 3D only.
 *
 * A launch point is a point on the MECHANISM, and a mechanism is inside the robot. On the default
 * 15x17 frame with a `frontback` mount, `launchLine` releases a dump at `mountOrigin('back')`
 * x = −7.50, z = `BB_LAUNCH_Z0` = 10 — which straddles both the frame box (x[−7.50,7.50],
 * z[0,18]) and the back mouth LINTEL (x[−10.50,−7.50], z[3.60,18.00]). In 2D that is harmless: a
 * flight element collides with nothing. In 3D it is a body created inside a closed 3-inch pocket,
 * and the measurement is unambiguous — all four elements of a dump rose ~2 in, jammed, and rode
 * the chassis at z≈12 without ever entering flight. 0/28 on the tutorial pose grid.
 *
 * ⚠️ **SIZED OFF `BB_NECTAR_R`, NOT `BB_POLLEN_R`.** The clearance a body needs is its OWN radius
 * plus this margin, and the march that finds it has to be able to cross the widest pocket the
 * biggest element can be born in. A margin cut to the POLLEN radius is one a NECTAR-carrying build
 * (a twin turret, a Box Tube dumper) sits inside of — the same bug, surviving in exactly the
 * builds that carry the bigger ball.
 */
export const BB3_LAUNCH_CLEAR_SLOP = BB_NECTAR_R / 2;

/** how far `syncElement` will march a newly created FLIGHT body along its own velocity looking
 * for clear air (in), and the step it marches in. The bound is generous — the deepest pocket on a
 * legal build is an intake reach plus two NECTAR diameters — and a body that finds no clear point
 * inside it is left exactly where the release put it rather than teleported somewhere arbitrary. */
export const BB3_LAUNCH_CLEAR_MAX = 24;
export const BB3_LAUNCH_CLEAR_STEP = BB_NECTAR_R / 4;

/** the readback rounding (in / rad) every dynamic body's JSON is written at (plan §3.1 step 6)
 * — see `sim3d/math3.ts`'s `round4`. */
export const BB3_ROUND = 1e-4;

/**
 * how many even angular steps a FLOWER ring plate's bore is tessellated into
 * (`sim3d/flowerTube.ts`; the four rectangle corners are inserted on top, so a plate is 36 rays
 * and 288 triangles).
 *
 * 32 is where the INSCRIBED polygon's error stops mattering: `r·(1 − cos(π/32))` is 0.010 in on
 * the 2.086-in top bore, against the 0.148-in clearance a NECTAR has through the middle bore and
 * the 0.211-in a POLLEN has through the lower one. Doubling it would buy 0.0025 in and cost 288
 * more triangles per plate across twelve plates, every one of which is in the broad phase for
 * the whole match.
 */
export const BB3_FLOWER_RING_SEGMENTS = 32;

/**
 * ⚠️ **THE FLOWER CAGE — THE TUBE HAS NO WALL BETWEEN ITS MIDDLE AND TOP PLATES, AND THAT IS
 * WHAT JAMS A COLUMN** (owner report: "POLLEN get stuck in a flower instead of dropping").
 *
 * MEASURED off the CAD hulls themselves (`scratch/flowercage.ts`: every static projected onto
 * the xy plane in the band, 2D-hulled, then a 1.4-in sphere centre marched out along 360
 * directions). Between the MID plate's top face (5.254) and the TOP plate's underside (20.254)
 * — 15.0 in, which is where elements 3 through 8 of a column live — the only solids are the four
 * HIPS pipes, round posts tangent to a cylinder of radius **1.929** at the four DIAGONALS. The
 * four gaps between them are open:
 *
 *   direction        a POLLEN centre can reach   a NECTAR centre can reach
 *   toward a pipe    0.530 in                    0.130 in
 *   into a gap       **1.046 in**                0.316 in
 *
 * Two POLLEN at opposite extremes are 2.09 in apart laterally and need 2.80 to pass each other,
 * so they SHOULDER and the column ARCHES: measured over 24 seeds of a settled column given a
 * seeded lateral kick, **10/24 (n=4) and 22–24/24 (n=7)** left an element hanging above an empty
 * tube, at centres 9.07 / 10.59 / 12.80 with 1.52 in between the lowest pair where 2.80 is the
 * touching pitch. The retrieval then refuses forever, because the bottom of the stack is nowhere
 * near the opening. Nothing was frozen and nothing was asleep — it is a friction arch.
 *
 * THE CAGE IS THE MIDDLE BORE, EXTENDED UPWARD: an `BB3_FLOWER_CAGE_SEGMENTS`-sided prism whose
 * FACES lie on the cylinder of radius `BB_FLOWER_MID_HOLE / 2` (1.948), spanning exactly that
 * plate-to-plate gap (`sim3d/flowerTube.ts`). It invents no dimension and it cannot stop
 * anything: **every element above the mid plate got there by passing that same 3.896-in bore**,
 * so a wall at that radius is an aperture it has already cleared, and it stands within 0.019 in
 * of where the pipes' own inner tangent circle already is. What it removes is the four gaps — a
 * POLLEN centre is capped at 0.548 in, a pair at 1.096, well under the 2.80 they would need to
 * shoulder past one another.
 *
 * ⚠️ **THE COUNT IS BOUNDED BELOW BY THE PIPES, NOT BY TASTE.** The prism is CIRCUMSCRIBED (see
 * `buildFlowerCage3d`), so its vertices sit at `1.948 / cos(π/N)` and its outermost point at that
 * plus `BB3_FLOWER_CAGE_T`, which has to clear the pipes' own 2.205: N = 6 is 2.375, N = 8 is
 * 2.233, N = 10 is 2.173 and **N = 12 is 2.142**. 10 would fit; 12 is taken because it costs
 * nothing — the cage is ONE trimesh collider per flower, so the segment count is vertices, not
 * broad-phase proxies. `buildFlowerCage3d`'s header carries the measurement that made a PRISM
 * the build rather than a fan of 48 cuboid slabs, and the short version is that the two cost the
 * same at the MEDIAN (~+13 % of `step3d`) and only the fan fails the AI lane's p95.
 */
export const BB3_FLOWER_CAGE_SEGMENTS = 12;

/**
 * how thick each cage slab is (in). APPROX, and the ONE thing it is sized against is the
 * OUTSIDE: the cage must not present the field a surface the four HIPS pipes do not already
 * present, or a robot's reach onto a flower moves. MEASURED over all four flowers, the tightest
 * pipe's own outermost face sits **2.205** in from the tube axis and a chassis flush on the
 * flower foot is `BB_PLACE_REACH` = 2.384 out.
 *
 * ⚠️ **AND THE NUMBER THAT HAS TO CLEAR THEM IS THE POLYGON'S VERTEX, NOT ITS FACE.** The cage
 * is circumscribed, so its furthest point is `1.948/cos(π/N) + t` = **2.142**, against a face
 * distance of 1.948 that looks far safer than the thing actually is. The build this started as
 * (a fan of 0.25-in cuboid slabs) read 2.198 at the face and **2.330** at the corner — 0.125 in
 * PAST the pipe a robot meets today, so a robot pressing on a flower would have stopped early,
 * and no check looking at the face would ever have said so. Tunnelling is not the constraint it
 * looks like: a 2.8-in sphere has to travel 2 r + t = 2.93 in in one tick (176 in/s) to skip the
 * wall, and CCD is already on above `BB3_CCD_SPEED` (60).
 *
*/
export const BB3_FLOWER_CAGE_T = 0.125;

/**
 * THE MIDDLE RING'S NECTAR LIP — the bore diameter (in) a NECTAR meets at the middle plate, and
 * only a NECTAR (`GROUP_NECTAR_SORTER`, `sim3d/groups.ts`).
 *
 * The CAD's middle bore is 3.896 and passes a 3.6-in NECTAR, so in the measured tube a NECTAR fell
 * to the tiles, sat in the retrieval opening, and a deployed ramp lifted it out over the 0.354-in
 * lower plate (owner, 2026-09-24: "not allowed and does not happen in real life"). G418 describes
 * a FLOWER that only lets POLLEN out "from the bottom of the middle ring", and the 2D model's
 * sorter ruling (owner, 2026-09-12) has always seated a NECTAR on that ring. This is the lip that
 * does it in 3D.
 *
 * 3.4 is between the two elements with room on both sides: 0.6 in over a 2.8 POLLEN (which never
 * meets it anyway), 0.2 under a 3.6 NECTAR. A NECTAR resting on it has its centre at 5.85 and its
 * bottom at 4.05, inside the scoring volume (from `BB_FLOWER_MID_Z`, 3.904), so a lone NECTAR now
 * scores in 3D as it always did in 2D (`docs/biobuzz/field-cad-audit.md` §11.3). It is drawn by
 * nothing: 0.25 in inside a 3.9-in bore, behind the HIPS pipes, is not a gap a player can see.
 */
export const BB3_FLOWER_NECTAR_SORT_D = 3.4;

/**
 * ⚠️ **HOW FAR OFF THE BORE AXIS A PLACED ELEMENT'S CENTRE IS SCATTERED (in)** — owner report:
 * "placing balls in a flower is too uniform". `flowerPlace3d` used to drop every element dead on
 * the axis at zero velocity, which produces a mathematically perfect stack (every POLLEN settled
 * at dxy 0.0000).
 *
 * APPROX, and it is a FRACTION OF THE TIGHTEST BORE THE ELEMENT FITS THROUGH, not a free number
 * and NOT a fraction of the cage: `sim3d/flowerTube.ts`'s `flowerDropSlack` answers 0.211 in for
 * a POLLEN (the 3.222 lower bore) and 0.148 for a NECTAR (the 3.896 middle one, because the
 * lower bore is what locks a nectar), so the offset is 0.158 and 0.111. Its header carries the
 * EJECTION that settled this: sized against the cage instead, at 0.411, a POLLEN dropped toward
 * the wall arrived 0.09 in inside the peanut supports and was thrown 8–28 in clear of the
 * flower. A radius drawn as `slack · sqrt(u)` at a uniform azimuth is uniform over the DISC,
 * which is what makes a column read as dropped rather than as a sine wave.
 *
 * ⚠️ **THE MEASUREMENT THAT USED TO SAY "DO NOT JITTER IT" WAS TRUE AND IS NOW OBSOLETE, AND
 * THE CAGE IS THE ENTIRE DIFFERENCE.** Before the cage, an offset of 0.032 in toppled a column
 * (worst pollen-pollen overlap 0.065 → 0.795 in, max dxy 1.015) because above the mid plate
 * nothing held the column vertical; the response was not proportional, so there was no small
 * safe value. With the cage the same sweep is FLAT at every offset from 0 to the full 0.548 of
 * slack — see `flower3d.ts`'s header for the re-run table.
 *
 * ⚠️ **AND THE FRACTION IS NOT WHAT DECIDES WHERE AN ELEMENT COMES TO REST.** Measured over
 * n = 1…8 × 8 seeds through the real place-and-settle, a column's elements end up at dxy
 * 0.54–0.67 whatever they were dropped at: a ball rolls off the one under it and the cage stops
 * it. The fraction decides the AZIMUTH SPREAD, which is the part that reads as natural (0.025 to
 * 1.224 in between the extremes of one column), and 1 is avoided only so a birth is never
 * exactly on the cage face.
 */
export const BB3_FLOWER_SCATTER_FRAC = 0.75;

// ── THE DYNAMIC HIVE SEE-SAW (plan §3.6) — calibrated block below ────────────────────────────

/**
 * THREE TERMS MAKE A BAR ON A HINGE BEHAVE LIKE THE REAL HIVE, and `scripts/hive-calibrate.ts`
 * solves all three against the Event Field Setup Guide's own load rows. They live in the
 * GENERATED BLOCK below so a re-run replaces the values (and their derivation) without touching
 * a word of this comment, which is the part a human wrote.
 *
 *  • **BALLAST** `BB3_HIVE_BALLAST` (lb) at `BB3_HIVE_BALLAST_AT` = `[v, w]` in the tray's own
 *    un-tilted local frame, `w` NEGATIVE (below the bar). This is what makes an EMPTY tray
 *    BI-STABLE: without it the tray is a symmetric bar on a frictionless hinge, it has no
 *    preferred pose, and the first element to land anywhere decides everything. Its sign is
 *    taken from the tray's own geometry at run time, not here (`sim3d/hive3d.ts`). The real hive
 *    is calibrated with ballast WASHERS (Event Field Setup Guide §12) — same hardware, same name.
 *  • **DETENT** `BB3_HIVE_DETENT` (torque, lb·in²/s²) — ⚠️ AS OF 2026-09-19 THIS IS A PIN THE
 *    TABLE LIFTS, NOT A BREAKAWAY THE LOAD BEATS. The release predicate is `BB_TIP_POLLEN` now
 *    (see `BB3_HIVE_DYNAMIC`'s header: one COUNT does not determine one TORQUE, measured across
 *    packings). This constant is still live as a DIAGNOSTIC — `hiveHoldTorque` and the HIVE3D
 *    lane still report it, and it is the measurement of how far the see-saw's own torque sits
 *    from the published table — but nothing releases on it any more.
 *  • **DAMPING** `BB3_HIVE_DAMPING` (angular damping, 1/s): the term that sets the SWING TIME.
 *    `BB_TIP_SWING_S` (4.0 s, owner ruling) is what the kinematic tray's timer plays back and
 *    what the dynamic tray has to REPRODUCE stop to stop under gravity alone. It is not a free
 *    choice once the other two are fixed: a see-saw released at one stop accelerates under the
 *    ballast's own torque, and the damping is the only thing between "four seconds" and "half a
 *    second and a bang".
 */

/** the tray assembly's own mass (lb) — APPROX. The CAD carries no density, so this is the
 * measured part VOLUMES times the materials they are made of: the two 20.1 × 11.75 × 14.0 cells
 * are 0.020-in ACM skin (≈ 2.7 g/cm³ over ≈ 3,900 in² of sheet ⇒ ≈ 7.7 lb), the 42.8-in aluminium
 * base tube and the ribs ≈ 4 lb, the AprilTag plates and hardware ≈ 1 lb. Flagged APPROX and
 * owner-weighable, exactly like `BB3_ELEMENT_MASS`; the calibration is run AGAINST it, so a real
 * weight is a re-run of `npm run hive-calibrate`, not an edit here. */
export const BB3_HIVE_TRAY_MASS = 13;

/** the joint is AT its stop when the tilt is within this of `BB_HIVE_TILT_DEG`, and the swing
 * is OVER when the bar is that close AND turning slower than `BB3_HIVE_REST_W` (rad/s). The
 * manual scores a TIP when the damper contacts the frame (§10.5.1 B), which is this. */
export const BB3_HIVE_STOP_DEG = 29;
export const BB3_HIVE_REST_W = 0.15;

/**
 * ⚠️ **A TIP THE TABLE CALLED FOR IS COMMITTED TO THE FAR STOP** (owner, 2026-09-20: "people are
 * still reporting hive not tipping in some cases") — the rad/s `hiveDetentHold` creeps a STALLED
 * swing forward at. It is an ANTI-STALL, not a swing rate: it binds only while the tray is
 * between its stops and turning toward the far stop SLOWER than this, which a healthy swing
 * never is (measured 0.20–0.50 rad/s throughout).
 *
 * The thing that stalls a freed see-saw is the game's own documented mechanic. `hiveTakingSide`
 * hands over at the release, so a driver who keeps firing through a swing is filling the RISING
 * cell — and a load in the rising cell is torque on the WRONG side of the pivot. MEASURED (fuzz
 * seed 9039, `scratch/hivemiss.ts`, 420 randomized volleys): a 4P3N tip broke away at tick 204,
 * spilled at level on 299, reached **−24.2°** — five degrees short of the far stop — and was
 * turned around there by 1 POLLEN + 3 NECTAR that had landed in the rising cell, coasting back to
 * its OWN stop, where the pin re-engaged. No tip, the load on the floor, and the state machine
 * left `released` latched (see `hiveDynamicTick`'s failed-swing reset, which is the other half of
 * this bug). 5 of 420 runs ended that way; 8 entered the latched state.
 *
 * Past CENTRE is not enough, which is why this runs to the far stop rather than to level: every
 * measured reversal happened well past level, at −24.2°, −20.6° and −9.0°.
 *
 * ⚠️ **AND IT IS 0.12, NOT A RATE THAT SETS THE PACE.** The first pass made it 0.25 — the mean
 * rate of a nominal 4 s swing — and applied it from the breakaway. A free swing accelerates from
 * zero and decelerates into its stop, so a floor AT the mean is well above the curve at both ends:
 * MEASURED, the lane's 8-POLLEN reference swing fell from 4.12 s to 3.12 and broke the owner's own
 * `BB_TIP_SWING_S` ruling. At 0.12, binding only between the stops, the same reference measures
 * **4.08 s** — 0.04 s of the tail — and every stall still clears. At the cell's own 19.8-in arm
 * 0.12 rad/s is 2.4 in/s of carry, a hundredth of the slowest shot the tray sees, and the measured
 * spill dispersal is unchanged (mean 61.0 in from the pivot either side, max 106.9).
 */
export const BB3_HIVE_TIP_CREEP_W = 0.12;

// ── BEGIN GENERATED: hive-calibrate ─────────────────────────────────────────────────────────
// Written by `npm run hive-calibrate`. DO NOT HAND-EDIT the four values below — edit the
// sweep, or the targets, and re-run. Everything outside these two markers is hand-written.
//
// DERIVATION. Every row was WEIGHED on the real tray — staged against the back wall in a line
//   per the field guide, four seconds to settle, the tray pinned at its stop so nothing tipped
//   while it was being weighed — and its settled contents' torque about the pivot read off the
//   bodies. One POLLEN is worth 909 of torque at the arm those rows settle at (8p minus 7p).
//   The rows that must NOT tip topped out at 5635; the rows that MUST tip bottomed out at 6197;
//   the threshold is that window's midpoint, 5916, i.e. ±0.31 element-weights of margin.
//   At a stop the ballast and the detent are DEGENERATE (both are terms in that one threshold),
//   so the lever arm was swept over w ∈ [-24, 0] and a 49/51 split taken: restoring
//   2874, detent 3041. The damping was fitted by bisection against a REAL 8-POLLEN
//   tip, stop to stop, at 4.00s against BB_TIP_SWING_S 4s.
//   Rows, through the real step3d pipeline (MISS = an owner-measured row a torque model cannot
//   reach at one nectar mass; see VALIDATION in the script for why that is expected):
//     OK   7p+0n   expect NO TIP got NO TIP margin +0.31 element-weights  [field guide §12.3]
//     OK   8p+0n   expect TIP    got TIP    margin +0.69 element-weights  [field guide §12.3]
//     OK   2p+3n   expect NO TIP got NO TIP margin +0.75 element-weights  [field guide §12.3]
//     OK   3p+3n   expect TIP    got TIP    margin +0.31 element-weights  [field guide §12.3]
//     MISS 6p+1n   expect NO TIP got TIP    margin -0.24 element-weights  [owner 2026-09-12 (1n needs 7p)]
//     OK   7p+1n   expect TIP    got TIP    margin +1.24 element-weights  [owner 2026-09-12]
//     MISS 5p+2n   expect NO TIP got TIP    margin -0.79 element-weights  [owner 2026-09-12 (2n needs 6p)]
//     OK   6p+2n   expect TIP    got TIP    margin +1.79 element-weights  [owner 2026-09-12]
//     OK   0p+4n   expect NO TIP got NO TIP margin +1.30 element-weights  [owner 2026-09-12 (4n needs 1p)]
//     MISS 1p+4n   expect TIP    got NO TIP margin -0.24 element-weights  [owner 2026-09-12]
//     OK   0p+5n   expect TIP    got TIP    margin +0.41 element-weights  [owner 2026-09-12 (5n tips alone)]
export const BB3_HIVE_BALLAST = 6;
export const BB3_HIVE_BALLAST_AT: readonly [number, number] = [0, -9.5];
export const BB3_HIVE_DETENT = 3041;
export const BB3_HIVE_DAMPING = 4.466;
// ── END GENERATED: hive-calibrate ───────────────────────────────────────────────────────────

// ── CLIENT-SIDE PREDICTION (plan §5) ─────────────────────────────────────────────────────────

/**
 * How far from the LOCAL robot a FULL prediction world carries elements as dynamic bodies (in).
 *
 * APPROX, and sized by what prediction is FOR: the thing a driver feels through the stick is
 * their own chassis meeting something, and at 82 in/s a 40-tick (0.67 s) reconcile window is
 * about 55 in of travel. Anything further away cannot reach the robot inside the window, so
 * carrying it would be paying wasm for a body that changes nothing. Elements outside the radius
 * are simply absent from the prediction world; the server's own snapshot corrects anything the
 * omission got wrong, which is the whole contract prediction runs under.
 */
export const PREDICT_ELEMENT_RADIUS = 36;

/**
 * An element already in the FULL prediction world STAYS in it past `PREDICT_ELEMENT_RADIUS` while
 * it is moving faster than this (in/s).
 *
 * The client draws a predicted element at the prediction's clock and every other element at the
 * interpolation clock, and the two are `INTERP_DELAY_TICKS` plus the prediction lead apart. For a
 * ball at rest that gap is nothing; for a shot at 200 in/s it is 30–40 in, so a shot that left the
 * radius mid-flight jumped back that far the frame it changed clocks (owner report 2026-09-24:
 * "the balls on the field keep teleporting"). Kept until it slows below this, the switch happens
 * where the two clocks agree to within about 2 in, which the draw eases in.
 */
export const PREDICT_ELEMENT_KEEP_SPEED = 12;

/**
 * The budget one FULL reconcile of 40 ticks may cost (ms) — plan §3.10 and §5's Auto decision.
 *
 * It is a DECISION THRESHOLD, not an assertion: `probeFullReconcileMs` times one real reconcile
 * during the pre-match countdown and Auto picks Full when the measurement lands under this and
 * Light when it does not. 8 ms is a sixth of a 60 Hz frame on the phone the plan sizes against,
 * which leaves the rest of the frame for the renderer.
 */
export const PREDICT_FULL_BUDGET_MS = 8;

/** the budget one LIGHT reconcile of 40 ticks may cost (ms). It has no wasm, no contacts and one
 * body, so this is a sanity floor rather than a threshold anything chooses on. */
export const PREDICT_LIGHT_BUDGET_MS = 1;

/** how many ticks a reconcile re-steps at most — `MAX_PREDICT_LEAD` in `src/game.ts`, named here
 * because both predictors and the Auto probe are sized against it and neither may import the
 * controller (it is DOM-adjacent and Lane C's). */
export const PREDICT_MAX_TICKS = 40;

// ─────────────────────────────────────────────────────────────────────────────
// R102: THE STARTING CUBE, AND THE DEPLOY LATCH (Day 3, `docs/biobuzz/plan-3d.md` §3.3)
//
// R105.A allows 29 in EXPANDED (the dial stops at `BB3_HEIGHT_MAX`, 18, so a coerced build
// never reaches the fold below; the rule still refuses a raw spec). R102 is the other half:
// the STARTING CONFIGURATION is an 18-inch cube, so a build that stands taller than 18 in has
// to fold to get under it and unfold once the match starts. Nothing in the 2D pipeline has ever
// asked; the 3D robot is a cuboid `length × width × heightIn`, so the day the height became
// real the start height became real with it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * R102's starting cube, vertical dimension (in) — the height a ROBOT must be inside at the
 * start of the MATCH. `ROBOT_MAX_SIZE` is the same 18 the two horizontal dimensions are capped
 * at (`BB_EXPANSION` is written against it), so this NAMES the vertical one rather than
 * declaring a second 18 that could drift from it.
 */
export const BB3_STOW_MAX = ROBOT_MAX_SIZE;

/** the height this build stands at once it has DEPLOYED (in) — `heightIn`, with the absent
 * default spelled once. */
export function bbDeployedHeightIn(spec: RobotSpec): number {
  return spec.heightIn ?? BB3_HEIGHT_DEFAULT;
}

/**
 * THE HEIGHT THIS BUILD STARTS THE MATCH AT (in) — its STOWED height.
 *
 * ⚠️ **IT IS DERIVED, AND THAT IS A DECISION WITH A DATE ON IT.** `RobotSpec` carries no
 * `stowHeightIn` field: adding one is a `src/types.ts` edit plus a carry-across in the shared
 * `coerceSpec` (`src/sim/spawn.ts`), both of which are outside this game's tree. So until that
 * field lands, a build is MODELLED as folding to exactly R102's cube — which is the honest
 * default for this game, because every BIOBUZZ build carries a DEPLOYING sweeper (see
 * `bbSizeLimits`' header: the sweeper is the reason chassis + reach is judged against R105's
 * prism and not against R102's cube) and a tall mechanism folds onto the deck the same way.
 *
 * A DECLARED stow WINS, and it is read STRUCTURALLY — `spec.stowHeightIn` if it is a finite
 * number — so the rule binds the day the field exists without a second edit here. That is also
 * what makes `bbStowLegal` REFUSABLE today rather than true by construction: a spec off the
 * wire that declares a 22-in stow on a 29-in robot is refused, and the smoke lane pins it.
 *
 * Never above the deployed height: a robot cannot stow TALLER than it stands.
 */
export function bbStowHeightIn(spec: RobotSpec): number {
  const deployed = bbDeployedHeightIn(spec);
  const declared = (spec as { stowHeightIn?: unknown }).stowHeightIn;
  if (typeof declared === 'number' && Number.isFinite(declared)) return Math.min(declared, deployed);
  return Math.min(deployed, BB3_STOW_MAX);
}

/** R102: does this build start inside the 18-in cube? The BUILD half of start legality — it is
 * a property of the robot, not of the pose, which is why `startLegal` answers it for an absent
 * pose too (a named anchor seats a legal POSE; it cannot seat a legal HEIGHT). */
export function bbStowLegal(spec: RobotSpec): boolean {
  return bbStowHeightIn(spec) <= BB3_STOW_MAX + 1e-9;
}

/**
 * IS THE ROBOT DEPLOYED RIGHT NOW — a READ of `world.match`, not a latch (plan §3.3).
 *
 * A latch would be a fourth thing that can disagree with the phase clock, and it would have to
 * ride `BiobuzzState` onto the wire, into every snapshot and into every replay to say something
 * the phase already says. Deployment happens once, at the edge out of `pre`, and never comes
 * back — so "has the match started" IS "is the robot deployed", and `freeplay` (free drive,
 * which never has a `pre`) is deployed by the same reading.
 */
export function bbDeployed(world: World): boolean {
  return world.match.phase !== 'pre';
}

/** the height the 3D chassis collider is built to RIGHT NOW: stowed before the match, deployed
 * after. The one reader is `sim3d/`, which rebuilds the collider at the edge. */
export function bbHeightNow(world: World, spec: RobotSpec): number {
  return bbDeployed(world) ? bbDeployedHeightIn(spec) : bbStowHeightIn(spec);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI DRIVERS (Day 3, `docs/biobuzz/plan-3d.md` §6) — the tuning `src/games/biobuzz/ai/` reads.
//
// EVERY NUMBER HERE IS `APPROX` AND NONE OF IT IS A RULE. These are a scripted driver's habits:
// how often it re-decides, how far off a wall it squares up, where it stands to shoot. Nothing
// in the manual constrains any of them, nothing else in the sim reads them, and changing one
// changes how well a bot plays and NOTHING ELSE — no score, no foul, no geometry. They live in
// this file rather than in `ai/` so the whole game's tuning is greppable in one place.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How often a bot RE-DECIDES, in ticks (plan §6: "re-decides every 6 ticks").
 *
 * Between decisions it HOLDS the command it last returned, which is what makes a bot seat's
 * recorded track hold-last friendly: a replay's command array compresses runs, and a driver
 * that emitted a fresh float every tick would be many times the bytes of a human's for no
 * benefit. It is also the right time constant for the job — 100 ms is about a human driver's
 * reaction, and a policy that re-solved a ballistic arc 60 times a second would chatter its
 * own aim.
 */
export const BB_AI_DECIDE_TICKS = 6;

/** how close to a perimeter wall (in) a bot squares its chassis up to it instead of steering
 * freely. Inside this band a diagonal approach catches a corner and wedges; square to the wall
 * it slides. APPROX. */
export const BB_AI_WALL_NEAR = 10;

/** how near the goal (in) counts as arrived — the bot stops translating and works the
 * mechanism. APPROX. */
export const BB_AI_ARRIVE_TOL = 2.5;

/**
 * ARRIVAL: inside this radius (in) a bot eases off the stick, down to `BB_AI_SLOW_FLOOR` of its
 * tier's cap at the goal itself.
 *
 * ⚠️ **WITHOUT IT, THE FASTEST TIER IS THE WORST ONE.** A bot holds one command for
 * `BB_AI_DECIDE_TICKS`, which at a legal top speed is about 8 in of travel — more than the 2.5-in
 * arrival tolerance — so a bot that drives at full stick right up to its firing spot sails past
 * it, turns around, and sails past it again, and never spends a decision window lined up. It was
 * measured: HARD (cap 1.0) scored 50.8 mean against an idle opponent while MEDIUM (cap 0.8)
 * scored 68.7, purely on overshoot. APPROX.
 */
export const BB_AI_SLOW_RADIUS = 12;
export const BB_AI_SLOW_FLOOR = 0.3;

/**
 * How near the COLLECT goal (in) counts as arrived — far tighter than `BB_AI_ARRIVE_TOL`,
 * because the collect goal is not a place, it is an ALIGNMENT.
 *
 * ⚠️ **THE ORDINARY TOLERANCE DEADLOCKS THE INTAKE.** The goal is the pose that puts the mouth
 * RECT's centre on the element, and the rect is only a few inches deep (`bbMouths`: `depth`
 * inside the frame, `reach` outside it). Stop 2.5 in short of that and the element is outside
 * the rect, `rectContains` says no, the bot reports "arrived", stops driving, and both sit there
 * — measured, for 140 seconds of one match, with the hopper at 2 and an element 2.5 in from the
 * roller. APPROX.
 */
export const BB_AI_GRAB_TOL = 0.5;

/**
 * How many DECISIONS a bot ignores an element it has given up on.
 *
 * A COOLDOWN rather than a permanent ban, because the field moves: a spill, a shove or the
 * opponent driving through can free what was wedged. How LONG a bot tries before giving up is a
 * TIER knob (`BbAiTierSpec.patience`) — it is the most expensive habit a weak driver has — but
 * how long it then stays away is the same for everyone. APPROX.
 */
export const BB_AI_TARGET_COOLDOWN = 120;

/**
 * How far around a given-up element (in) the bot writes off its NEIGHBOURS too.
 *
 * ⚠️ **WITHOUT IT, GIVING UP ON ONE ELEMENT IS GIVING UP ON NOTHING.** Elements that cannot be
 * reached are almost never alone — they are a PILE, in a corner, behind a FLOWER foot, against
 * the perimeter, because whatever put one there put its neighbours there too. A bot that writes
 * off exactly one then picks the element six inches to its left and spends the same patience on
 * it, and the one after that. Measured: a HARD bot ground through a corner pile for 90 seconds
 * of a 150-second match — pressed against the wall the whole time, never captured anything,
 * finished on 34 points against its own 110-point solo average. APPROX.
 */
export const BB_AI_GIVEUP_RADIUS = 8;

/**
 * COMMITMENT: how much closer a NEW element has to be, as a fraction of the distance to the one
 * the bot is already going for, before it is worth switching.
 *
 * ⚠️ **A GREEDY NEAREST-ELEMENT RULE RE-EVALUATED EVERY DECISION DOES NOT CONVERGE.** Halfway to
 * an element, the nearest one is usually a DIFFERENT element — the bot has moved, the field has
 * moved, and whichever it now turns toward will be beaten by a third a moment later. The bot
 * arrives nowhere, and the effect is WORST for the tier that re-decides most, which is the tier
 * that is meant to be best: the same policy with hesitation (a tier that skips most decisions and
 * therefore keeps last window's plan) out-collected the one without it. Hysteresis is the fix,
 * and it belongs in the policy rather than in a tier's hands. APPROX.
 */
export const BB_AI_SWITCH_FRAC = 0.6;

/** P gain on a bot's heading error, per radian, before the ±1 clamp. 2.2 settles a chassis
 * inside a decision window without overshooting into a hunt. APPROX. */
export const BB_AI_TURN_GAIN = 2.2;

/**
 * VERTICAL CLEARANCE a bot keeps under the HIVE (in), on top of its own height.
 *
 * `BB_HIVE_LOWEST_Z` (30.652, CAD) is the lowest structure on the assembly, so a 29-in robot
 * clears it by 1.65 in on paper and by nothing at all once its mechanism, its held elements or
 * a tilted tray are in the way. A bot that is `heightIn + this` or taller stays out of the
 * footprint entirely — plan §6's "stay clear of the hive footprint when tall". APPROX.
 */
export const BB_AI_HIVE_CLEARANCE = 2;

/** how far outside the HIVE's own footprint (in) the keep-out reaches for a tall bot. APPROX. */
export const BB_AI_HIVE_KEEPOUT_PAD = 6;

/**
 * Where a bot STANDS to shoot, measured OUTBOARD of the up CELL's mouth (in).
 *
 * Outboard, not anywhere: `hiveAccepts` takes an element only over the cell's open outer lip
 * (`hiveApproachSign`), so a stand-off on the pivot side is a shot that bounces off the closed
 * back. Two numbers because the two launchers have opposite failure modes — a TURRET too CLOSE
 * runs out of elevation (the arc to a 59-in cell from 15 in away wants 81°, past
 * `BB_TURRET_PITCH_MAX`), a DUMPER too FAR runs out of `BB_DUMP_MAX_DIST`. Both APPROX.
 */
export const BB_AI_TURRET_STANDOFF = 36;
export const BB_AI_DUMP_STANDOFF = 20;

/** how close to its own LOADING ZONE (in) a bot has to be before it spends a NECTAR entry
 * (`bbNectar`). A NECTAR sitting in the zone is one the opponent can drive to, so the entry is
 * spent when the robot is there to collect it — the same thing a drive team does. APPROX. */
export const BB_AI_LZ_GUARD = 42;

/**
 * How much room (in) a bot keeps around ANOTHER ROBOT, on top of the two half-diagonals.
 *
 * ⚠️ **THIS IS A FOUL AVOIDANCE NUMBER, NOT A DRIVING STYLE.** Measured before it existed: a
 * full-speed bot routing straight through an opponent parked on the same line collected G421
 * PINNING majors four times in one match (80 points, handed to the opponent) while shouldering
 * the HIVE on the way through, and LOST head-to-head to a tier that drove at half speed and
 * therefore never reached anybody. The faster tier has to be the cleaner one or "harder" just
 * means "gives away more points". (The measurement also predates G417's removal, 2026-09-19 —
 * the HIVE contact itself no longer costs anything, but the PINNING alone made the case.)
 * APPROX.
 */
export const BB_AI_ROBOT_CLEAR = 6;

/**
 * How many DECISIONS of sustained contact with another ROBOT before a bot backs off — the
 * G421 clock, read from the bot's side.
 *
 * ⚠️ **A FAST BOT THAT DOES NOT DO THIS LOSES TO A SLOW ONE.** G421 bills a MAJOR (20 points, to
 * the robot being leaned on) for PINNING an opponent for more than 3 seconds, and it re-bills
 * every three seconds after that. Measured before this existed: the HARD tier — 2.5x the EASY
 * tier's solo score — LOST 12 of 20 head-to-heads, because the matches it lost were the ones
 * where EASY's total ran to 83, 88, 112 and 123 points, almost all of it fouls HARD had handed
 * it. 12 decisions is 1.2 s, comfortably inside the rule's 3. APPROX.
 */
export const BB_AI_PIN_DECISIONS = 12;

/**
 * The speed cap (fraction of stick) a bot uses inside the HIVE footprint.
 *
 * ⚠️ **G417 (STRATEGIC ramming of the HIVE) IS REMOVED, 2026-09-19** — there is no longer a
 * closing-speed test this creep needs to stay under. The value is kept as MEASURED TUNING
 * rather than reverted: it was set when the fix for a bot driving under the assembly (the
 * space under the trays is the shortest path across the field, and G409's drive-under is
 * legal) was to arrive slowly, and undoing it is a behaviour change to a bot that currently
 * passes `test:ai`'s win-rate ratchet, not a correctness fix. Leave it until that ~9-minute
 * lane is re-run and shows the cap can move without cost. APPROX.
 */
export const BB_AI_HIVE_CREEP = 0.45;

/** speed (in/s) under which a bot that is COMMANDING full drive counts as stuck, and how many
 * consecutive decisions of it before the bot backs out. APPROX. */
export const BB_AI_STUCK_SPEED = 4;
export const BB_AI_STUCK_DECISIONS = 5;
/** how many decisions a stuck bot spends reversing and turning before it re-plans. APPROX. */
export const BB_AI_ESCAPE_DECISIONS = 3;
