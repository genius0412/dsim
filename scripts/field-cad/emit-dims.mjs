// scripts/field-cad/emit-dims.mjs — turn `public/models/biobuzz/field-measurements.json` into
// `src/games/biobuzz/fieldDims.gen.ts`, the ONE place the BIOBUZZ field's dimensions are written
// down (owner ruling 2026-09-18: "the CAD is authoritative for dimensions").
//
// ── WHY A GENERATOR AND NOT A HAND-TYPED TABLE ───────────────────────────────────────────────
// `config.ts` used to carry the field size as literals read off the manual's figures (±72, a
// 24-in tile, `BB_FLOWERS` on the ±24 seam). The CAD measures ±70.674, a 23.528-in tile and a
// bore 2.629 in off the wall, and two rounds of "fix the number by hand" shipped guesses. A
// generated module removes the transcription step entirely: every value below states the JSON
// path it came from, and the SIM3D smoke lane RE-RENDERS this file and diffs it byte for byte,
// so a measurements file that moves and a constants file that does not is a red test.
//
// ── THE RULES THE DERIVATIONS FOLLOW ─────────────────────────────────────────────────────────
//  • SYMMETRY IS ENFORCED, NOT ASSUMED. The real field is point-symmetric and the CAD measures
//    each instance separately, so anything that comes in fours (wall faces, flower bores, hive
//    cells) is emitted as the MEAN of the measured instances with the worst residual printed in
//    the header. A residual is the honest way to say "these four agree"; picking instance 0 and
//    hoping is not.
//  • ROUNDED TO 1e-3 in. The CAD's own tessellation deflection is 0.25–1.5 mm (0.01–0.06 in), so
//    a fourth decimal is noise, and a determinism-sensitive sim wants short exact literals.
//  • A ZONE EDGE THAT IS A WALL IS THE WALL. Tape never runs onto the perimeter (audit §5), so
//    every zone rectangle's wall-bounded edge is snapped from the tape's own end to the wall
//    face. `SNAP_IN` below is the threshold, and the snap is asserted to be small.
//  • WHAT THE JSON DOES NOT CARRY IS NOT INVENTED. The flower's per-ring z bands and its
//    on-tile footprint are measured in `docs/biobuzz/field-cad-audit.md` §6 but are not in
//    `field-measurements.json`; they stay in `config.ts` as manual figures, flagged there.
//    Adding them here would mean changing `convert.py`, which would rewrite the GLB and the
//    collider set as a side effect of a dimensions change.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCE } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const MEASUREMENTS_PATH = path.join(REPO_ROOT, 'public', 'models', 'biobuzz', 'field-measurements.json');
export const GEN_PATH = path.join(REPO_ROOT, 'src', 'games', 'biobuzz', 'fieldDims.gen.ts');

/** how far a tape end may sit from a perimeter wall face and still be read as "this edge IS the
 * wall" (in). The CAD's on-tile tape stops 0.573 in clear of the inner face and the alliance
 * area's tape stops 0.976 in outside it; the next-nearest zone edge is 2.573 in away, so 1.25
 * separates them with room to spare and the actual snap distance is printed in the header. */
const SNAP_IN = 1.25;

const ALLIANCES = ['red', 'blue'];

const r3 = (v) => {
  const x = Math.round(v * 1000) / 1000;
  return Object.is(x, -0) ? 0 : x;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** the mean, and the worst distance from it — the pair every symmetric value is emitted as. */
function agree(xs) {
  const m = mean(xs);
  // `raw` is the unrounded mean: every DERIVED length (a span, a half-extent) is computed from
  // `raw` and rounded ONCE at the end, because rounding twice walks a value off by 1e-3 — the
  // cell width came out 20.142 instead of 20.141 the first time this was written.
  return { raw: m, value: r3(m), residual: r3(Math.max(...xs.map((x) => Math.abs(x - m)))), n: xs.length };
}
function must(cond, msg) {
  if (!cond) throw new Error(`[emit-dims] ${msg}`);
}
const num = (v) => {
  const s = String(v);
  return s;
};

/** a rectangle's union with another, both `{x0,x1,y0,y1}`. */
function unite(a, b) {
  return b
    ? { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }
    : a;
}
const stripRect = (t) => ({ x0: t.x[0], x1: t.x[1], y0: t.y[0], y1: t.y[1] });

/**
 * Snap any edge of `rect` that lies within `SNAP_IN` of a perimeter wall face onto that face.
 * Returns the snapped rect plus the largest distance any edge moved, which the header prints.
 */
function snapToWalls(rect, half) {
  let moved = 0;
  const out = { ...rect };
  for (const key of ['x0', 'x1', 'y0', 'y1']) {
    // the NEARER of the two faces on that axis, not the one the suffix suggests: the ALLIANCE
    // AREA lies OUTSIDE the perimeter, so its field-side edge is its `x1` sitting against the
    // NEGATIVE wall for red. Keying the target off `x0`/`x1` left that edge unsnapped.
    const target = out[key] < 0 ? -half : half;
    const d = Math.abs(out[key] - target);
    if (d <= SNAP_IN) {
      moved = Math.max(moved, d);
      out[key] = target;
    }
  }
  return { rect: out, moved: r3(moved) };
}

/** the whole derivation, as data — so the emitter and any checker agree by construction. */
export function buildDims(m) {
  const notes = [];

  // ── WALLS ────────────────────────────────────────────────────────────────────────────────
  const faces = m.walls.innerFace;
  const faceMags = [faces.left, faces.right, faces.rear, faces.audience].map(Math.abs);
  const half = agree(faceMags);
  must(half.residual <= 0.01, `the four wall inner faces disagree by ${half.residual}in`);
  notes.push(
    `FIELD_HALF   ${half.value}  = mean |walls.innerFace.{left,right,rear,audience}| over ${half.n} faces, worst residual ${half.residual}in ` +
      `(the CAD's four faces ARE symmetric). Interior span ${r3(2 * half.value)}in, against the 144 the manual's "12 ft field" implies.`,
  );
  const wallH = r3(m.walls.assemblyZ[1]);
  const glassZ = m.walls.glassZ.map(r3);
  notes.push(`WALL_H       ${wallH}  = walls.assemblyZ[1] (the top rail's top). Glass alone spans z ${glassZ[0]}..${glassZ[1]} (walls.glassZ).`);

  // ── TILES ────────────────────────────────────────────────────────────────────────────────
  const pitch = r3(m.tiles.pitch);
  const tileSpan = agree([...m.tiles.extent.x.map(Math.abs), ...m.tiles.extent.y.map(Math.abs)]);
  must(tileSpan.residual <= 0.01, `the tile field is not square: residual ${tileSpan.residual}in`);
  // THE JOINTS, NOT THE BOUNDING BOXES. `x0Seams` is each tile column's bbox MINIMUM, and an interior
  // tile's bbox runs out to the tips of its interlock tabs, so it sits half an interlock off the
  // joint. A joint is the middle of the band two neighbours' tabs share, [x0[i], max of tile i−1];
  // tile i−1's max is not in the measurements, but the tiles are laid 180°-point-symmetric (the
  // extent is, residual below), so it is −x0[6−i].
  const x0 = m.tiles.x0Seams;
  must(x0.length === 6, `expected 6 tile columns, got ${x0.length}`);
  const joints = [1, 2, 3, 4, 5].map((i) => {
    const band = -x0[6 - i] - x0[i];
    must(band > 0.5 && band < 1.2, `tile columns ${i - 1}/${i} do not interlock: a ${band}in band`);
    return r3((x0[i] - x0[6 - i]) / 2);
  });
  const jointPitch = agree(joints.slice(1).map((j, i) => j - joints[i]));
  must(jointPitch.residual <= 0.01, `the tile joints are not evenly spaced: residual ${jointPitch.residual}in`);
  const seams = [r3(x0[0]), ...joints, r3(m.tiles.extent.x[1])];
  notes.push(
    `TILE_PITCH   ${pitch}  = tiles.pitch (a real FTC soft tile is 23.53 in on centre, not 24 — this is the whole field-size finding).`,
  );
  notes.push(
    `TILE_SEAMS   ${seams.length} lines = the two perimeter edges and the five tile JOINTS, each the middle of the band where two columns'` +
      `\n//                tabs overlap (tiles.x0Seams[i] .. −x0Seams[6−i], by the layout's point symmetry). The joints are evenly spaced at` +
      `\n//                ${jointPitch.value}in (residual ${jointPitch.residual}); the outer tiles are cut straight and run ${r3(joints[0] - seams[0])}in. TILE_PITCH is the mean.`,
  );
  notes.push(`TILE_SPAN_HALF ${tileSpan.value}  = mean |tiles.extent.{x,y}|, residual ${tileSpan.residual}in — the tiles stop ${r3(half.value - tileSpan.value)}in short of the wall.`);

  // ── FLOWERS ──────────────────────────────────────────────────────────────────────────────
  // Each flower stands on one wall, so ONE of its bore coordinates is the wall-normal (the
  // stand-off) and the other is the along-wall station. Which is which follows from the sign
  // pattern in the config table, so it is derived from the measurement itself: the coordinate
  // with the LARGER magnitude is the wall-normal one.
  const flowerRows = m.flowers.map((f) => {
    const [bx, by] = f.bore.top.centre;
    const normalIsX = Math.abs(bx) > Math.abs(by);
    return {
      id: f.id,
      normal: normalIsX ? bx : by,
      along: normalIsX ? by : bx,
      wall: normalIsX ? (bx < 0 ? 'left' : 'right') : by > 0 ? 'rear' : 'audience',
      nearest: f.id === 'F1' || f.id === 'F2' ? 'red' : 'blue',
      normalIsX,
    };
  });
  must(flowerRows.length === 4, `expected 4 flowers, got ${flowerRows.length}`);
  const bore = agree(flowerRows.map((f) => Math.abs(f.normal)));
  const along = agree(flowerRows.map((f) => Math.abs(f.along)));
  const flowerD = r3(half.raw - bore.raw);
  notes.push(
    `FLOWER_D     ${flowerD}  = FIELD_HALF − mean |top-ring bore centre, wall-normal axis| (${bore.value}, residual ${bore.residual}in over ${bore.n} flowers).` +
      `\n//                The old hand-entered 2.54 is ${r3(Math.abs(flowerD - 2.54))}in off — the flower was never misplaced, the FIELD was.`,
  );
  notes.push(
    `FLOWER_ALONG ${along.value}  = mean |bore centre, along-wall axis| (residual ${along.residual}in). The old ±24 was the 24-in tile seam; the real` +
      `\n//                seam is at ${along.value}, which is one tile of accumulated pitch error.`,
  );
  const ringD = {
    top: agree(m.flowers.map((f) => f.bore.top.diameter)),
    mid: agree(m.flowers.map((f) => f.bore.mid.diameter)),
    lower: agree(m.flowers.map((f) => f.bore.lower.diameter)),
  };
  notes.push(
    `FLOWER_RING_D top ${ringD.top.value} / mid ${ringD.mid.value} / lower ${ringD.lower.value}  = mean least-squares bore diameters ` +
      `(residuals ${ringD.top.residual}/${ringD.mid.residual}/${ringD.lower.residual}in).`,
  );
  const extentZ = [agree(m.flowers.map((f) => f.extent.z[0])), agree(m.flowers.map((f) => f.extent.z[1]))];
  notes.push(
    `FLOWER_EXTENT_Z [${extentZ[0].value}, ${extentZ[1].value}]  = mean flowers[].extent.z — the WHOLE assembly (the top is the purple backstop, the` +
      `\n//                bottom is the under-field bracket). FLOWER_RING_Z below is the per-PLATE band, which is what BB_FLOWER_TOP_Z reads now.`,
  );

  // ── FLOWER RING PLATES (Day 2 lane A) ────────────────────────────────────────────────────
  // `convert.py` now separates the three plates from the assembly, so the four figures that
  // stayed hand-typed in `config.ts` — the top ring's height, the middle ring's underside, the
  // lower ring's top face and the on-tile footprint — are measurements like everything else.
  must(
    m.flowers.every((f) => f.rings && f.rings.top && f.rings.mid && f.rings.lower),
    'a flower is missing one of its three ring plates — re-run `npm run field-cad` after a convert.py change',
  );
  const ringBand = (label) => [
    agree(m.flowers.map((f) => f.rings[label].z[0])),
    agree(m.flowers.map((f) => f.rings[label].z[1])),
  ];
  const ringZ = { top: ringBand('top'), mid: ringBand('mid'), lower: ringBand('lower') };
  const ringZResidual = r3(
    Math.max(...['top', 'mid', 'lower'].flatMap((k) => [ringZ[k][0].residual, ringZ[k][1].residual])),
  );
  const retrieval = [ringZ.lower[1], ringZ.mid[0]];
  notes.push(
    `FLOWER_RING_Z top [${ringZ.top[0].value}, ${ringZ.top[1].value}] / mid [${ringZ.mid[0].value}, ${ringZ.mid[1].value}] / lower [${ringZ.lower[0].value}, ${ringZ.lower[1].value}]  = mean of each PLATE's` +
      `\n//                own z band (worst residual ${ringZResidual}in). The clear gap between the lower plate's TOP and the mid plate's UNDERSIDE is` +
      `\n//                ${r3(retrieval[1].raw - retrieval[0].raw)}in — Fig 9-12's 3.55-in RETRIEVAL OPENING, derived rather than assumed, and the sharpest confirmation in this file.` +
      `\n//                BB_FLOWER_TOP_Z was the manual's 21.5 (Δ ${r3(Math.abs(21.5 - ringZ.top[1].raw))}); BB_FLOWER_MID_Z an APPROX 3.98 (Δ ${r3(Math.abs(3.98 - ringZ.mid[0].raw))}); BB_FLOWER_FLOOR_Z an APPROX 0.43 (Δ ${r3(Math.abs(0.43 - ringZ.lower[1].raw))}).`,
  );
  const foot = {
    along: agree(m.flowers.map((f) => f.foot.along)),
    deep: agree(m.flowers.map((f) => f.foot.deep)),
  };
  notes.push(
    `FLOWER_FOOT  ${foot.along.value} × ${foot.deep.value}  = the union of the three ring plates' own footprints, along the wall × into the field (residuals` +
      `\n//                ${foot.along.residual}/${foot.deep.residual}in). The hand-typed 6 × 4.9 was within 0.05 / 0.11. This is the on-tile solid a robot meets; flowers[].extent` +
      `\n//                is NOT — it carries the backstop above the top plate and the bracket behind the wall plane.`,
  );
  const flowers = flowerRows.map((f) => {
    const n = Math.sign(f.normal) * r3(half.value - flowerD);
    const a = Math.sign(f.along) * along.value;
    return { id: f.id, wall: f.wall, x: r3(f.normalIsX ? n : a), y: r3(f.normalIsX ? a : n), nearest: f.nearest };
  });

  // ── HIVE ─────────────────────────────────────────────────────────────────────────────────
  const trays = ALLIANCES.map((a) => m.hive.trays[a]);
  const pivotX = agree(trays.map((t) => Math.abs(t.pivot[0])));
  const pivotZ = r3(m.hive.pivotZ);
  const tilt = agree(trays.map((t) => Math.abs(t.captureThetaDeg)));
  const cells = trays.flatMap((t) => [t.cells.north, t.cells.south]);
  must(cells.length === 4, `expected 4 hive cells, got ${cells.length}`);
  const xHalf = agree(cells.map((c) => c.xHalf));
  const near = agree(cells.map((c) => Math.min(Math.abs(c.vMin), Math.abs(c.vMax))));
  const far = agree(cells.map((c) => Math.max(Math.abs(c.vMin), Math.abs(c.vMax))));
  const floorW = agree(cells.map((c) => c.wMin));
  const topW = agree(cells.map((c) => c.wMax));
  const openZ = ALLIANCES.map((a) => m.hive.openingZ[a]);
  const openBottom = agree(openZ.map((z) => z[0]));
  const openTop = agree(openZ.map((z) => z[1]));
  const downFloor = agree(ALLIANCES.map((a) => m.hive.downCellFloorZ[a]));
  const lowest = r3(m.hive.lowestStructureZAtRest.z);
  const hive = {
    PIVOT_X: pivotX.value,
    PIVOT_Z: pivotZ,
    TILT_DEG: tilt.value,
    ARM: r3((near.raw + far.raw) / 2),
    LEN: r3(2 * far.raw),
    CELL_W: r3(2 * xHalf.raw),
    CELL_D: r3(far.raw - near.raw),
    CELL_H: r3(topW.raw - floorW.raw),
    CELL_NEAR: near.value,
    CELL_FAR: far.value,
    CELL_FLOOR_W: floorW.value,
    CELL_TOP_W: topW.value,
    OPEN_Z: [openBottom.value, openTop.value],
    DOWN_FLOOR_Z: downFloor.value,
    LOWEST_Z: lowest,
    UP_STAGED: { red: m.hive.trays.red.upStaged, blue: m.hive.trays.blue.upStaged },
  };
  must(hive.TILT_DEG === 30, `the tray tilt is ${hive.TILT_DEG}°, not the 30° every plan projection is built on`);
  notes.push(
    `HIVE.PIVOT_X ${hive.PIVOT_X} / PIVOT_Z ${hive.PIVOT_Z} / TILT_DEG ${hive.TILT_DEG}  = mean |trays[].pivot[0]| (residual ${pivotX.residual}), hive.pivotZ,` +
      `\n//                mean |trays[].captureThetaDeg| (residual ${tilt.residual}). The tilt is EXACTLY 30° — audit §4.1 proves it by un-tilting the` +
      `\n//                0.020-in back skin and watching it collapse to its own thickness.`,
  );
  notes.push(
    `HIVE cells   ARM ${hive.ARM} · LEN ${hive.LEN} · CELL_W ${hive.CELL_W} · CELL_D ${hive.CELL_D} · CELL_H ${hive.CELL_H}  — all TRUE lengths along the bar,` +
      `\n//                from the mean of the 4 measured cells (trays[].cells[]; residuals xHalf ${xHalf.residual}, near ${near.residual}, far ${far.residual},` +
      `\n//                floor ${floorW.residual}, top ${topW.residual}in). ARM = (near+far)/2, LEN = 2·far, CELL_D = far−near, CELL_H = top−floor.` +
      `\n//                config.ts's PLAN lengths are these × cos 30°.`,
  );
  notes.push(
    `HIVE.OPEN_Z  [${hive.OPEN_Z[0]}, ${hive.OPEN_Z[1]}]  = mean hive.openingZ[] (residuals ${openBottom.residual}/${openTop.residual}in) — the up cell's mouth at rest.` +
      `\n//                The manual's Fig 9-10 prints [53.5, 65.6]; the CAD agrees to 0.13 in, which is why this one is a confirmation, not a move.`,
  );
  notes.push(
    `HIVE.DOWN_FLOOR_Z ${hive.DOWN_FLOOR_Z} / LOWEST_Z ${hive.LOWEST_Z}  = mean hive.downCellFloorZ[] (residual ${downFloor.residual}in) and` +
      `\n//                hive.lowestStructureZAtRest.z ("${m.hive.lowestStructureZAtRest.part}"). Fig 9-10's 25.5 is ${r3(hive.DOWN_FLOOR_Z - 25.5)}in low: one rigid bar` +
      `\n//                cannot put the up mouth at 53.4 and the down floor at 25.5 at the same time. A 29-in robot ${hive.LOWEST_Z > 29 ? 'CLEARS' : 'does NOT clear'} the structure.`,
  );

  // ── TAPE, AND THE ZONES IT DEFINES ───────────────────────────────────────────────────────
  const widths = m.tape.widthsIn.map(r3);
  must(widths.length === 1 && widths[0] === 1, `expected one tape width of 1.000in, got ${JSON.stringify(widths)}`);
  must(m.tape.parts.length === 16, `expected 16 tape parts, got ${m.tape.parts.length}`);
  // Classified by the part's own NOMINAL LENGTH, which is printed in the STEP part name and is
  // the one attribute that names the strip's job: 22.69 = a GARDEN band half, 20.69 = a LOADING
  // ZONE's inner edge, 11 = one of its two depth edges, 54/94.82 = the ALLIANCE AREA outline.
  const BY_LENGTH = { 22.69: 'garden', 20.69: 'loadingZone', 11: 'loadingZone', 54: 'allianceArea', 94.82: 'allianceArea' };
  const EXPECTED = { garden: 2, loadingZone: 3, allianceArea: 3 };
  const byColour = { ff0000: 'red', '0000ff': 'blue' };
  const tape = { loadingZone: { red: [], blue: [] }, garden: { red: [], blue: [] }, allianceArea: { red: [], blue: [] } };
  for (const t of m.tape.parts) {
    const group = BY_LENGTH[t.nominalLengthIn];
    const a = byColour[t.colour];
    must(group && a, `tape part "${t.part}" has no group (length ${t.nominalLengthIn}, colour ${t.colour})`);
    tape[group][a].push(stripRect(t));
  }
  for (const group of Object.keys(EXPECTED)) {
    for (const a of ALLIANCES) {
      must(
        tape[group][a].length === EXPECTED[group],
        `${a} ${group}: expected ${EXPECTED[group]} tape strips, got ${tape[group][a].length}`,
      );
      // deterministic order, so a re-render is byte-identical whatever order the JSON lists
      tape[group][a].sort((p, q) => p.x0 - q.x0 || p.y0 - q.y0);
      tape[group][a] = tape[group][a].map((rct) => ({ x0: r3(rct.x0), x1: r3(rct.x1), y0: r3(rct.y0), y1: r3(rct.y1) }));
    }
  }
  // ── SUPPLEMENTAL STRIPS — drawn, but NOT in the CAD ──────────────────────────────────────
  //
  // The ONLY thing in this file that is not a measurement, and it is deliberately its own group
  // so nothing can mistake it for one: `TAPE.garden` stays exactly the CAD's four strips, and
  // the SIM3D lane's "no DRAWN tape strip runs onto a perimeter wall" check keeps binding them.
  //
  // WHY. A GARDEN is a 2-in band of two 1-in tapes run into the alliance's corner, and the CAD's
  // band stops 0.573 in clear of the wall at that corner (§5.1 — no tape ever runs onto the
  // perimeter). `GARDEN` below, which is the SCORED zone, snaps that edge ONTO the wall, so the
  // band as drawn left the zone's own corner unmarked: on screen the band visibly stops short of
  // the corner it is defined to reach (2026-09-18 playtest, "add a very tiny short section of
  // tape on the bounds"). One 0.573 x 2.000 in patch per alliance closes it.
  //
  // The band's LONG side has the same 0.573 in gap against the wall it runs along, over its whole
  // 23.265 in. It is left alone: it is not "a very tiny short section", it is against the wall
  // base where nothing reads it, and the CAD is right about it.
  //
  // Zone rectangles are computed from `TAPE[group]` ONLY, so this table cannot move a rule.
  const gardenSupplement = { red: [], blue: [] };
  for (const a of ALLIANCES) {
    const band = tape.garden[a].reduce((acc, rct) => unite(rct, acc), tape.garden[a][0]);
    // the band's own END, on whichever x face the corner is: red runs from the left wall, blue
    // from the right. Take the end that is NEAR a wall face and bridge it.
    const nearX0 = Math.abs(band.x0 + half.value);
    const nearX1 = Math.abs(band.x1 - half.value);
    const patch =
      nearX0 <= nearX1
        ? { x0: r3(-half.value), x1: r3(band.x0), y0: r3(band.y0), y1: r3(band.y1) }
        : { x0: r3(band.x1), x1: r3(half.value), y0: r3(band.y0), y1: r3(band.y1) };
    const len = r3(patch.x1 - patch.x0);
    must(len > 0 && len <= SNAP_IN, `${a} garden corner patch is ${len}in long — expected a sub-${SNAP_IN}in bridge to the wall`);
    gardenSupplement[a] = [patch];
  }
  tape.gardenSupplement = gardenSupplement;
  notes.push(
    `TAPE.gardenSupplement    NOT MEASURED — one ${r3(gardenSupplement.red[0].x1 - gardenSupplement.red[0].x0)} x ${r3(gardenSupplement.red[0].y1 - gardenSupplement.red[0].y0)} in patch per alliance,` +
      `\n//                bridging the GARDEN band's corner end to the perimeter face so the drawn band covers the whole of` +
      `\n//                \`GARDEN\` (which snaps that edge onto the wall). Its own group: \`TAPE.garden\` stays the CAD's, and` +
      `\n//                the zone rectangles below are built from \`TAPE.garden\` alone, so this cannot move a rule.`,
  );

  const zones = {};
  const snaps = [];
  for (const group of Object.keys(EXPECTED)) {
    zones[group] = {};
    for (const a of ALLIANCES) {
      const union = tape[group][a].reduce((acc, rct) => unite(rct, acc), tape[group][a][0]);
      const { rect, moved } = snapToWalls(union, half.value);
      snaps.push(`${a} ${group} ${moved}in`);
      zones[group][a] = { x0: r3(rect.x0), x1: r3(rect.x1), y0: r3(rect.y0), y1: r3(rect.y1) };
    }
  }
  notes.push(
    `TAPE         ${m.tape.parts.length} strips, every one ${widths[0]}.000 in wide, grouped by the nominal length in the STEP part name` +
      `\n//                (22.69 = a GARDEN band half, 20.69 = a LOADING ZONE's inner edge, 11 = a depth edge, 54/94.82 = the ALLIANCE AREA).` +
      `\n//                A zone edge that is a WALL carries NO tape (audit §5) — the on-tile strips stop ${r3(half.value - 70.101)}in clear of the inner face.`,
  );
  notes.push(
    `LZ/GARDEN/ALLIANCE_AREA  = the union of that group's strips, with any edge within ${SNAP_IN}in of a wall face snapped ONTO it (moved: ${snaps.join(', ')}).` +
      `\n//                "Bounded by tape and the wall, tape included" (§9.3) is exactly that rule: the tape's own outer face is the zone edge` +
      `\n//                everywhere except where the perimeter is.`,
  );

  return {
    FIELD_HALF: half.value,
    WALL_FACE: { left: r3(faces.left), right: r3(faces.right), rear: r3(faces.rear), audience: r3(faces.audience) },
    WALL_H: wallH,
    WALL_GLASS_Z: glassZ,
    TILE_PITCH: pitch,
    TILE_SPAN_HALF: tileSpan.value,
    TILE_SEAMS: seams,
    FLOWER_D: flowerD,
    FLOWER_ALONG: along.value,
    FLOWERS: flowers,
    FLOWER_RING_D: { top: ringD.top.value, mid: ringD.mid.value, lower: ringD.lower.value },
    FLOWER_RING_Z: {
      top: [ringZ.top[0].value, ringZ.top[1].value],
      mid: [ringZ.mid[0].value, ringZ.mid[1].value],
      lower: [ringZ.lower[0].value, ringZ.lower[1].value],
    },
    FLOWER_RETRIEVAL_Z: [retrieval[0].value, retrieval[1].value],
    FLOWER_FOOT: { along: foot.along.value, deep: foot.deep.value },
    FLOWER_EXTENT_Z: [extentZ[0].value, extentZ[1].value],
    HIVE: hive,
    TAPE_W: widths[0],
    TAPE: tape,
    LZ: zones.loadingZone,
    GARDEN: zones.garden,
    ALLIANCE_AREA: zones.allianceArea,
    notes,
  };
}

const rect = (r) => `{ x0: ${num(r.x0)}, x1: ${num(r.x1)}, y0: ${num(r.y0)}, y1: ${num(r.y1)} }`;
const rectList = (rs, pad) => `[\n${rs.map((r) => `${pad}  ${rect(r)},`).join('\n')}\n${pad}]`;

/** the generated module's source text. Deterministic: nothing here reads a clock. */
export function renderDims(measurementsJson) {
  const m = JSON.parse(measurementsJson);
  const d = buildDims(m);
  const sha = crypto.createHash('sha256').update(measurementsJson).digest('hex');
  const L = [];
  L.push(`// GENERATED by scripts/field-cad/emit-dims.mjs — DO NOT HAND-EDIT. Re-run \`npm run field-cad\`.`);
  L.push(`//`);
  L.push(`// THE BIOBUZZ FIELD'S DIMENSIONS, MEASURED OFF FIRST's OWN FIELD CAD.`);
  L.push(`// Owner ruling, 2026-09-18: "The CAD is authoritative for dimensions." Where a figure in the`);
  L.push(`// V1 Competition Manual disagrees with a number below, the number below wins and the figure is`);
  L.push(`// kept in \`config.ts\` as history. \`docs/biobuzz/field-cad-audit.md\` is the measurement report.`);
  L.push(`//`);
  L.push(`// source STEP : FIRST field CAD ${SOURCE.version} (${SOURCE.versionDate}), sha256 ${SOURCE.sha256}`);
  L.push(`//               captured ${SOURCE.capturedOn} from ${SOURCE.url}`);
  L.push(`// measured by : scripts/field-cad/convert.py → public/models/biobuzz/field-measurements.json`);
  L.push(`//               sha256 ${sha}`);
  L.push(`// frame       : the sim frame — inches, origin at the field centre on the tile top surface,`);
  L.push(`//               +x audience right, +y away from the audience. Rounded to 1e-3 in.`);
  L.push(`//`);
  L.push(`// ── EVERY VALUE, AND WHERE IT COMES FROM ────────────────────────────────────────────────────`);
  for (const n of d.notes) L.push(`// ${n}`);
  L.push(`//`);
  L.push(`// ✅ CLOSED 2026-09-18 (Day 2 lane A): the flower's three RING PLATE z bands and its on-tile`);
  L.push(`// FOOTPRINT used to be measured in the audit (§6) but not carried by \`field-measurements.json\`,`);
  L.push(`// so \`BB_FLOWER_TOP_Z\`, \`BB_FLOWER_MID_Z\`, \`BB_FLOWER_FLOOR_Z\` and \`BB_FLOWER_FOOT\` stayed hand-typed.`);
  L.push(`// \`convert.py\` now separates the plates from the assembly and \`FLOWER_RING_Z\` / \`FLOWER_FOOT\``);
  L.push(`// below are the measurements; \`config.ts\` reads them and no flower dimension is APPROX any more.`);
  L.push(`// The GLBs are byte-identical across that change — the plates were always in the visual export.`);
  L.push(``);
  L.push(`/** an axis-aligned field region, world inches. Structurally identical to \`config.ts\`'s`);
  L.push(` * \`BbRect\` — declared here so this module imports nothing at all. */`);
  L.push(`export interface BbGenRect {`);
  L.push(`  readonly x0: number;`);
  L.push(`  readonly x1: number;`);
  L.push(`  readonly y0: number;`);
  L.push(`  readonly y1: number;`);
  L.push(`}`);
  L.push(``);
  L.push(`/** half the clear span inside the perimeter (in) — the wall's INNER face. */`);
  L.push(`export const FIELD_HALF = ${num(d.FIELD_HALF)};`);
  L.push(``);
  L.push(`/** the four measured inner faces, unaveraged — what an agreement check compares a collider to. */`);
  L.push(`export const WALL_FACE: { readonly left: number; readonly right: number; readonly rear: number; readonly audience: number } = {`);
  L.push(`  left: ${num(d.WALL_FACE.left)},`);
  L.push(`  right: ${num(d.WALL_FACE.right)},`);
  L.push(`  rear: ${num(d.WALL_FACE.rear)},`);
  L.push(`  audience: ${num(d.WALL_FACE.audience)},`);
  L.push(`};`);
  L.push(``);
  L.push(`/** the perimeter assembly's own height above the tiles (in) — rail top, not the physics wall. */`);
  L.push(`export const WALL_H = ${num(d.WALL_H)};`);
  L.push(`/** the polycarbonate pane's own z span (in). */`);
  L.push(`export const WALL_GLASS_Z: readonly [number, number] = [${num(d.WALL_GLASS_Z[0])}, ${num(d.WALL_GLASS_Z[1])}];`);
  L.push(``);
  L.push(`/** soft-tile pitch on centre (in) — the mean seam spacing. NOT 24. */`);
  L.push(`export const TILE_PITCH = ${num(d.TILE_PITCH)};`);
  L.push(`/** half the tiled floor's own span (in) — the tiles stop short of the wall. */`);
  L.push(`export const TILE_SPAN_HALF = ${num(d.TILE_SPAN_HALF)};`);
  L.push(`/** the seven seam lines, on both axes (in): the two perimeter edges and the five tile joints — see the header. */`);
  L.push(`export const TILE_SEAMS: readonly number[] = [${d.TILE_SEAMS.map(num).join(', ')}];`);
  L.push(``);
  L.push(`/** a FLOWER's ring-bore centre, off its own wall's inner face (in). */`);
  L.push(`export const FLOWER_D = ${num(d.FLOWER_D)};`);
  L.push(`/** a FLOWER's station ALONG its wall (in), from the field centre. */`);
  L.push(`export const FLOWER_ALONG = ${num(d.FLOWER_ALONG)};`);
  L.push(`/** the four ring-bore centres, in the sim frame. */`);
  L.push(
    `export const FLOWERS: readonly { readonly id: string; readonly wall: 'left' | 'rear' | 'right' | 'audience'; readonly x: number; readonly y: number; readonly nearest: 'red' | 'blue' }[] = [`,
  );
  for (const f of d.FLOWERS) {
    L.push(`  { id: '${f.id}', wall: '${f.wall}', x: ${num(f.x)}, y: ${num(f.y)}, nearest: '${f.nearest}' },`);
  }
  L.push(`];`);
  L.push(`/** the three ring plates' bore DIAMETERS (in): what fits through the top, middle and bottom. */`);
  L.push(`export const FLOWER_RING_D: { readonly top: number; readonly mid: number; readonly lower: number } = { top: ${num(d.FLOWER_RING_D.top)}, mid: ${num(d.FLOWER_RING_D.mid)}, lower: ${num(d.FLOWER_RING_D.lower)} };`);
  L.push(`/** each ring PLATE's own z band (in), [underside, top face]. The tube bottom to top is the`);
  L.push(` * lower plate, the retrieval opening, the mid plate, the scoring volume, the top plate. */`);
  L.push(`export const FLOWER_RING_Z: {`);
  L.push(`  readonly top: readonly [number, number];`);
  L.push(`  readonly mid: readonly [number, number];`);
  L.push(`  readonly lower: readonly [number, number];`);
  L.push(`} = {`);
  L.push(`  top: [${num(d.FLOWER_RING_Z.top[0])}, ${num(d.FLOWER_RING_Z.top[1])}],`);
  L.push(`  mid: [${num(d.FLOWER_RING_Z.mid[0])}, ${num(d.FLOWER_RING_Z.mid[1])}],`);
  L.push(`  lower: [${num(d.FLOWER_RING_Z.lower[0])}, ${num(d.FLOWER_RING_Z.lower[1])}],`);
  L.push(`};`);
  L.push(`/** the RETRIEVAL OPENING's own z span (in) — the clear gap between the lower plate's top face`);
  L.push(` * and the mid plate's underside, ${num(r3(d.FLOWER_RETRIEVAL_Z[1] - d.FLOWER_RETRIEVAL_Z[0]))} in tall against Fig 9-12's 3.55. */`);
  L.push(`export const FLOWER_RETRIEVAL_Z: readonly [number, number] = [${num(d.FLOWER_RETRIEVAL_Z[0])}, ${num(d.FLOWER_RETRIEVAL_Z[1])}];`);
  L.push(`/** the on-tile FOOTPRINT of a flower's ring plates (in) — along its wall × into the field. */`);
  L.push(`export const FLOWER_FOOT: { readonly along: number; readonly deep: number } = { along: ${num(d.FLOWER_FOOT.along)}, deep: ${num(d.FLOWER_FOOT.deep)} };`);
  L.push(`/** the whole flower assembly's z span (in) — backstop top, under-field bracket bottom. */`);
  L.push(`export const FLOWER_EXTENT_Z: readonly [number, number] = [${num(d.FLOWER_EXTENT_Z[0])}, ${num(d.FLOWER_EXTENT_Z[1])}];`);
  L.push(``);
  L.push(`/** the HIVE, in TRUE lengths along its own bar (in) — \`config.ts\` projects them by cos 30°. */`);
  L.push(`export const HIVE: {`);
  L.push(`  readonly PIVOT_X: number;`);
  L.push(`  readonly PIVOT_Z: number;`);
  L.push(`  readonly TILT_DEG: number;`);
  L.push(`  readonly ARM: number;`);
  L.push(`  readonly LEN: number;`);
  L.push(`  readonly CELL_W: number;`);
  L.push(`  readonly CELL_D: number;`);
  L.push(`  readonly CELL_H: number;`);
  L.push(`  readonly CELL_NEAR: number;`);
  L.push(`  readonly CELL_FAR: number;`);
  L.push(`  readonly CELL_FLOOR_W: number;`);
  L.push(`  readonly CELL_TOP_W: number;`);
  L.push(`  readonly OPEN_Z: readonly [number, number];`);
  L.push(`  readonly DOWN_FLOOR_Z: number;`);
  L.push(`  readonly LOWEST_Z: number;`);
  L.push(`  readonly UP_STAGED: { readonly red: 'north' | 'south'; readonly blue: 'north' | 'south' };`);
  L.push(`} = {`);
  L.push(`  PIVOT_X: ${num(d.HIVE.PIVOT_X)},`);
  L.push(`  PIVOT_Z: ${num(d.HIVE.PIVOT_Z)},`);
  L.push(`  TILT_DEG: ${num(d.HIVE.TILT_DEG)},`);
  L.push(`  ARM: ${num(d.HIVE.ARM)},`);
  L.push(`  LEN: ${num(d.HIVE.LEN)},`);
  L.push(`  CELL_W: ${num(d.HIVE.CELL_W)},`);
  L.push(`  CELL_D: ${num(d.HIVE.CELL_D)},`);
  L.push(`  CELL_H: ${num(d.HIVE.CELL_H)},`);
  L.push(`  CELL_NEAR: ${num(d.HIVE.CELL_NEAR)},`);
  L.push(`  CELL_FAR: ${num(d.HIVE.CELL_FAR)},`);
  L.push(`  CELL_FLOOR_W: ${num(d.HIVE.CELL_FLOOR_W)},`);
  L.push(`  CELL_TOP_W: ${num(d.HIVE.CELL_TOP_W)},`);
  L.push(`  OPEN_Z: [${num(d.HIVE.OPEN_Z[0])}, ${num(d.HIVE.OPEN_Z[1])}],`);
  L.push(`  DOWN_FLOOR_Z: ${num(d.HIVE.DOWN_FLOOR_Z)},`);
  L.push(`  LOWEST_Z: ${num(d.HIVE.LOWEST_Z)},`);
  L.push(`  UP_STAGED: { red: '${d.HIVE.UP_STAGED.red}', blue: '${d.HIVE.UP_STAGED.blue}' },`);
  L.push(`};`);
  L.push(``);
  L.push(`/** gaffer tape width (in) — the only width on this field. */`);
  L.push(`export const TAPE_W = ${num(d.TAPE_W)};`);
  L.push(``);
  L.push(`/** every tape STRIP, as the rectangle the CAD puts it at. A renderer draws THESE, not an`);
  L.push(` * outline of the zone: the wall-bounded edge of a zone carries no tape. */`);
  L.push(`export const TAPE: {`);
  L.push(`  readonly loadingZone: { readonly red: readonly BbGenRect[]; readonly blue: readonly BbGenRect[] };`);
  L.push(`  readonly garden: { readonly red: readonly BbGenRect[]; readonly blue: readonly BbGenRect[] };`);
  L.push(`  readonly allianceArea: { readonly red: readonly BbGenRect[]; readonly blue: readonly BbGenRect[] };`);
  L.push(`  /** NOT CAD — see the header. Drawn beside \`garden\`; never part of a zone rectangle. */`);
  L.push(`  readonly gardenSupplement: { readonly red: readonly BbGenRect[]; readonly blue: readonly BbGenRect[] };`);
  L.push(`} = {`);
  for (const group of ['loadingZone', 'garden', 'allianceArea', 'gardenSupplement']) {
    L.push(`  ${group}: {`);
    for (const a of ALLIANCES) L.push(`    ${a}: ${rectList(d.TAPE[group][a], '    ')},`);
    L.push(`  },`);
  }
  L.push(`};`);
  L.push(``);
  for (const [name, doc] of [
    ['LZ', 'the LOADING ZONE — the side wall and three 1-in tapes, tape included (§9.3).'],
    ['GARDEN', 'the GARDEN — the 2-in band of two tapes, run into the alliance corner and closed by the two walls.'],
    ['ALLIANCE_AREA', 'the ALLIANCE AREA, on the gym floor OUTSIDE the perimeter (three strips, the field side open).'],
  ]) {
    L.push(`/** ${doc} */`);
    L.push(`export const ${name}: { readonly red: BbGenRect; readonly blue: BbGenRect } = {`);
    for (const a of ALLIANCES) L.push(`  ${a}: ${rect(d[name][a])},`);
    L.push(`};`);
    L.push(``);
  }
  return L.join('\n');
}

export function emitDims({ measurementsPath = MEASUREMENTS_PATH, outPath = GEN_PATH } = {}) {
  const json = readFileSync(measurementsPath, 'utf8');
  const source = renderDims(json);
  writeFileSync(outPath, source);
  return { outPath, bytes: Buffer.byteLength(source) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const res = emitDims();
  console.log(`[emit-dims] wrote ${res.outPath} (${res.bytes} bytes)`);
}
