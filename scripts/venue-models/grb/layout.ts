/**
 * THE GRB VENUE'S NUMBERS (2026-11-04) — Halls B3 and A3, Level 3, George R. Brown Convention Center,
 * Houston, as the FIRST Tech Challenge used them at the 2026 FIRST Championship (DECODE season,
 * 29 April – 2 May 2026). Every number here is either MEASURED off one of two drawings or ESTIMATED,
 * and says which. `docs/venues/grb.md` carries the sources, the method and every deviation.
 *
 * ── THE FRAME ────────────────────────────────────────────────────────────────────────────────
 * FEET, in the BIOBUZZ field frame: our field (FRANKLIN division, field 1) at the origin, +x the
 * audience's right, +y away from the audience, z up from the hall floor. On the drawings that is plan
 * x to the right and plan y DOWN reversed: the bottom row of divisions faces the concourse wall, and
 * that is where FRANKLIN's audience sits. `generate.ts` turns this into glTF metres.
 *
 * ── THE TWO DRAWINGS ─────────────────────────────────────────────────────────────────────────
 *  PLAN  FIRST's 2026 FTC floor plan raster (`FloorPlanForWebsite20260304.png`, 1266 × 747). Its scale
 *        is 0.502 ft/px, from the building's own 90-ft column pitch (179.5 px) and 180-ft column-pair
 *        spacing (358.4 px); a 12-ft field measures 24 px on it, which agrees. `p(x, y)` below turns
 *        a plan pixel into this frame.
 *  CAD   the GRB's own Halls A3–B3 plan (`HALL_A3_B3_….pdf`), vector, read layer by layer (columns,
 *        walls, floor pockets, the airwall). Its unit is 1.5133 per foot: the floor pockets are on a
 *        30-ft grid (45.4 units) and the hall's 371-ft depth and A3's 324-ft length come out right.
 *        It is registered to PLAN by two column lines.
 */

/** plan pixels → field-frame feet (PLAN scale; our field's centre is plan (897, 406)) */
export const PLAN_FT_PER_PX = 0.502;
export function p(x: number, y: number): [number, number] {
  return [(x - 897) * PLAN_FT_PER_PX, -(y - 406) * PLAN_FT_PER_PX];
}
/** a plan rectangle (pixels) → field-frame feet { x0, x1, y0, y1 } with x0 < x1, y0 < y1 */
export function pr(x0: number, y0: number, x1: number, y1: number): Rect {
  const [a, b] = p(x0, y0);
  const [c, d] = p(x1, y1);
  return { x0: Math.min(a, c), x1: Math.max(a, c), y0: Math.min(b, d), y1: Math.max(b, d) };
}

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// ── THE HALL (CAD) ────────────────────────────────────────────────────────────────────────────

/** clear height to the underside of the roof structure: GRB "Dimensions & Capacities", Level 3
 * exhibit halls, 30 ft (MEASURED: published) */
export const CEILING_FT = 30;
/** the inside faces of the four walls (CAD). B3's end wall, A3's west wall, the dock wall (drive-in
 * ramps, docks 43–55) and the concourse wall (stairs, escalators, the doors in from the concourse). */
export const WALLS = {
  b3End: 165.2,
  a3End: -445.9,
  dock: 188.8,
  concourse: -186.4,
} as const;
/** the A3/B3 airwall line (CAD layer L3|AIRWALL). OPEN for the event: the FTC plan runs ROBOT HELP &
 * INSPECTION straight across it, so it is drawn as its retracted pocket, not as a wall. */
export const AIRWALL_X = -121.6;

/** COLUMN LINES along x (CAD layer L3|COL-EXHIBIT-HALL; every 90 ft, A3's are offset by the 30-ft
 * airwall bay). Each line carries a TRIPLET at each of two y bands: two big round columns 38 ft
 * apart with a small one between, under a beam (the CAD's dashed double line). */
export const COLUMN_X = [157.2, 67.2, -22.8, -112.9, -142.9, -202.9, -292.9, -382.9] as const;
/** the column-line on each end wall (CAD L3|COL-2): pilasters in the wall, the same triplets */
export const WALL_COLUMN_X = [157.2, -442.9] as const;
/** the two triplet bands: [outer, inner] big-column y (CAD), dock side and concourse side */
export const COLUMN_Y = { dock: [144.4, 106.2], concourse: [-73.7, -35.7] } as const;
/** big-column diameters (CAD circle sizes: 7.6 units on B3's two middle lines, 6.1 elsewhere) */
export const COLUMN_D_FT = (x: number): number => (Math.abs(x - 67.2) < 1 || Math.abs(x + 22.8) < 1 ? 5.0 : 4.0);
/** the small column between each pair (CAD: 4.4-unit circle) */
export const MID_COLUMN_D_FT = 2.9;
/** the drive-in doors in the dock wall, [x0, x1] feet (CAD layer L3|DOORS, the 11–25 ft openings;
 * heights ESTIMATED in `generate.ts`) */
export const DOCK_DOORS: readonly [number, number][] = [
  [-333.4, -308.4], [-264.0, -239.0], [-235.6, -210.2], [-175.2, -162.1], [-159.2, -145.7],
  [-81.3, -56.7], [7.0, 30.0], [35.1, 58.4], [96.5, 107.5], [112.5, 123.5],
];
/** personnel door sets, [from, to] feet along each wall (CAD door swings, grouped where leaves touch;
 * sets that open into the corner rooms rather than the hall are left out) */
export const PERSON_DOORS = {
  dock: [[-431.7, -427.3], [-416.1, -411.7], [-398.9, -387.8], [-378.2, -375.4], [-366.0, -356.4], [-349.6, -337.5], [-276.3, -267.3], [-207.4, -198.4], [-139.2, -126.5], [-95.5, -86.4], [-53.1, -44.0], [-3.5, 2.4], [124.8, 127.6]],
  concourse: [[-435.0, -429.7], [-299.4, -289.6], [-287.0, -280.7], [-275.2, -272.2], [-133.5, -130.6], [-124.7, -118.4], [-16.9, -10.7], [-4.0, -1.1], [127.5, 130.4], [136.3, 139.2], [145.5, 151.7]],
  b3End: [[-89.6, -80.9], [-29.4, -26.5], [-5.3, -2.5], [29.2, 32.0], [57.9, 70.0], [74.0, 76.9], [110.2, 113.1], [129.4, 131.8]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

/** floor pockets (CAD layer L3|flr-pkt-halls): a 30-ft grid, one at (x0 + 30i, y0 + 30j). Steel lids,
 * about 12 × 18 in (lid size ESTIMATED). */
export const FLOOR_POCKET = { x0: -18.6, y0: 129.0, pitch: 30 } as const;

// ── THE ROOF (ESTIMATED from photographs; see the doc) ────────────────────────────────────────────

/** primary trusses run along y on every column line, bearing on the triplets; depth ~L/12 for the
 * 142-ft clear span between the bands (ESTIMATED) */
export const PRIMARY_TRUSS = { depthFt: 11, chordFt: 1.4, panelFt: 10 } as const;
/** secondary open-web joists along x between primaries, every 10 ft (ESTIMATED) */
export const JOIST = { pitchFt: 10, depthFt: 5, chordFt: 0.5 } as const;
/** the roof deck's underside (ESTIMATED: on the primaries' top chord) */
export const DECK_FT = CEILING_FT + PRIMARY_TRUSS.depthFt + 0.5;

// ── THE EVENT LAYOUT (PLAN, 2026) ─────────────────────────────────────────────────────────────────

export type DivisionName = 'edison' | 'franklin' | 'goodall' | 'ross' | 'lovelace' | 'jackson';

export interface Division {
  name: DivisionName;
  /** +1: the audience sits at −y (the bottom row, ours); −1: at +y (the top row, turned 180°) */
  facing: 1 | -1;
  /** the two field centres (x), field 1 then field 2, at `fieldY` */
  fieldX: [number, number];
  fieldY: number;
  /** the dark carpet the fields and drive teams stand on */
  carpet: Rect;
  /** the white zone behind the carpet (scoring, field staff) up to the drape on the centre aisle */
  back: Rect;
  /** the grandstand (the grey block), its front at the edge nearest the field */
  stand: Rect;
  /** the accessible-seating platform the stand pushes out toward the fields */
  access: Rect;
  /** the two team-media boxes either side of it */
  media: [Rect, Rect];
}

/** FRANKLIN's field 2, x: the plan's 28.1 ft plus `TWIN_SHIFT_FT` (see `DIVISIONS`) */
export const TWIN_SHIFT_FT = 33.5 - p(953, 0)[0];

/** MEASURED off PLAN, fields by the light-grey squares (centres ±0.5 px), carpets by the dark grey,
 * stands by the mid grey, the drape (blue line) by eye at 6× zoom.
 * ⚠️ ONE DEVIATION: FRANKLIN's field 2 stands at x 33.5 ft, not the plan's 28.1. The sim's widest
 * driver eye (a portrait phone, setback 240 in) stands 293 in either side of our field's centre, and
 * the clear room must hold it with its 24-in margin (`KEEP_CLEAR`, `generate.ts`); at 28.1 ft field
 * 2's perimeter would stand at 265 in. Moved 5.4 ft with its carpet; its near alliance station keeps
 * no table (`KEEP_CLEAR` drops it). */
export const DIVISIONS: readonly Division[] = [
  {
    name: 'edison',
    facing: 1,
    fieldX: [p(734, 0)[0], p(789.5, 0)[0]],
    fieldY: 0,
    carpet: pr(706, 381, 819, 428),
    back: pr(706, 372.5, 819, 381),
    stand: pr(684, 473, 841, 613),
    access: pr(742, 455, 775, 473),
    media: [pr(718, 455, 741, 472), pr(776, 455, 800, 472)],
  },
  {
    name: 'franklin',
    facing: 1,
    fieldX: [0, 33.5],
    fieldY: 0,
    carpet: { ...pr(868, 390, 981, 428), x1: p(981, 0)[0] + TWIN_SHIFT_FT },
    back: { ...pr(866, 372.5, 981, 390), x1: p(981, 0)[0] + TWIN_SHIFT_FT },
    stand: pr(865, 473, 1021, 613),
    access: pr(908, 456, 940, 473),
    media: [pr(882.5, 453, 905.8, 472), pr(943, 453, 967.5, 472)],
  },
  {
    name: 'goodall',
    facing: 1,
    fieldX: [p(1062.5, 0)[0], p(1118.5, 0)[0]],
    fieldY: 0,
    carpet: pr(1033, 381, 1146, 428),
    back: pr(1033, 372.5, 1146, 381),
    stand: pr(1045, 473, 1162, 613),
    access: pr(1072, 456, 1103, 473),
    media: [pr(1047, 455, 1071, 472), pr(1104, 455, 1128, 472)],
  },
  {
    name: 'ross',
    facing: -1,
    fieldX: [p(789.5, 0)[0], p(733.5, 0)[0]],
    fieldY: p(0, 310)[1],
    carpet: pr(704, 287, 817, 335),
    back: pr(704, 335, 817, 345),
    stand: pr(683, 102, 842, 245),
    access: pr(745, 245, 777, 262),
    media: [pr(721, 245, 744, 262), pr(778, 245, 801, 262)],
  },
  {
    name: 'lovelace',
    facing: -1,
    fieldX: [p(954.5, 0)[0], p(899, 0)[0]],
    fieldY: p(0, 310)[1],
    carpet: pr(868, 287, 979, 335),
    back: pr(868, 335, 979, 345),
    stand: pr(865, 102, 1020, 245),
    access: pr(909, 245, 941, 262),
    media: [pr(885, 245, 908, 262), pr(942, 245, 965, 262)],
  },
  {
    name: 'jackson',
    facing: -1,
    fieldX: [p(1119, 0)[0], p(1062.5, 0)[0]],
    fieldY: p(0, 310)[1],
    carpet: pr(1033, 287, 1146, 335),
    back: pr(1033, 335, 1146, 345),
    stand: pr(1047, 102, 1165, 245),
    access: pr(1074, 245, 1105, 262),
    media: [pr(1050, 245, 1073, 262), pr(1106, 245, 1130, 262)],
  },
];

/** the drape lines (PLAN blue) between the centre aisle and each row's back zone, y of each */
export const AISLE_DRAPE_Y = { bottom: p(0, 372.5)[1], top: p(0, 345)[1] } as const;
/** the storage strips round the column triplets between stands (PLAN khaki; "Storage?" on PLAN) */
export const STORAGE: readonly Rect[] = [
  pr(844, 472, 861, 572),
  pr(1024, 472, 1041, 572),
  pr(843, 115, 864, 245),
  pr(1021, 115, 1046, 245),
];
/** robot queue carts in the gaps between divisions (PLAN: small red/blue rectangles), [x, y] centres.
 * ⚠️ The two in the EDISON–FRANKLIN gap are left out: they stand inside the clear room. */
export const QUEUE_CARTS: readonly [number, number][] = [
  p(1026, 392), p(1036, 392), p(1028, 323), p(1038, 323),
  p(860, 323), p(850, 323), p(696, 392), p(686, 392), p(694, 323), p(684, 323),
];

// ── HEIGHTS AND SIZES OF EVENT EQUIPMENT ──────────────────────────────────────────────────────────

/** FTC CMP 2026 coach orientation, "Elevated Fields & Ladders" (MEASURED: published) */
export const DS_TABLE = { heightIn: 26, lengthIn: 72, depthIn: 30 } as const;
export const HP_TABLE = { heightIn: 20, sideIn: 13.4 } as const;
/** competition fields stand on 24-in risers (DECODE manual §15.2.1; coach orientation). ⚠️ NOT
 * DRAWN under the competition fields: see the doc ("the risers"). The practice fields' are. */
export const RISER_IN = 24;
/** the stands: rental grandstand, ESTIMATED from photographs (rows, rise) and PLAN (footprint) */
export const STAND = { rowDepthIn: 32, riseIn: 11, rows: 24, frontAisleFt: 6, aisles: 2, aisleFt: 4, railIn: 42 } as const;
/** pipe and drape: 8-ft black round the competition back zones and storage (ESTIMATED: the usual
 * height); pits 10 ft square with an 8-ft back and 3-ft sides (PLAN pit size, 10 × 10 × 10 ft per the
 * coach orientation; drape heights ESTIMATED from the GES standard booth kit) */
export const DRAPE = { backFt: 8, pitBackFt: 8, pitSideFt: 3 } as const;
/** each division's lighting grid: a box truss over the carpet, trimmed at 24 ft (ESTIMATED from the
 * 2025 photographs, where the grid hangs well under the 30-ft roof chord) */
export const LIGHT_TRUSS = { trimFt: 24, sizeIn: 20.5, chordIn: 2, frontFt: 6, backFt: 5 } as const;
/** a 16:9 LED wall per field over the back zone, facing the audience (ESTIMATED: the 2025 photos show
 * one per field hung behind it; the 2026 plan does not draw screens) */
export const SCREEN = { wFt: 16, hFt: 9, bottomFt: 13 } as const;

/** pit drape colours by division (FTC CMP 2026 coach orientation, "Team Pits": Edison canary,
 * Franklin pink, Goodall blue, Jackson salmon, Lovelace green, Ross grey). The linear-ish sRGB values
 * are this model's, chosen desaturated so no pit outshines the field. */
export const PIT_DRAPE: Record<DivisionName, number> = {
  edison: 0xc9b65a,
  franklin: 0xb8749c,
  goodall: 0x5f86b0,
  jackson: 0xc98b6e,
  lovelace: 0x5d8c57,
  ross: 0x8a8c8f,
};

/** the 14 practice fields at A3's west wall (PLAN), fields 1–6 on risers. [x, y] centres, feet. */
export const PRACTICE_FIELDS: readonly { at: [number, number]; riser: boolean }[] = [122.8, 167.5, 214.2, 255.8, 300.8, 344.2, 386.7].flatMap(
  (y, row) => [
    { at: p(89, y), riser: row < 3 },
    { at: p(43, y), riser: row < 3 },
  ],
);

/** enclosures on the A3 side of the open airwall (PLAN), drape-walled */
export const ENCLOSURES: readonly { name: string; at: Rect; tables: number }[] = [
  { name: 'robot-help', at: pr(570, 70, 680, 245), tables: 6 },
  { name: 'storage-a', at: pr(557, 270, 622, 335), tables: 0 },
  { name: 'production-a', at: pr(624, 270, 676, 335), tables: 2 },
  { name: 'storage-b', at: pr(588, 380, 615, 445), tables: 0 },
  { name: 'production-b', at: pr(616, 380, 675, 445), tables: 3 },
  { name: 'pit-admin', at: pr(608, 470, 680, 600), tables: 4 },
];
