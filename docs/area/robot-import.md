<!-- governs: src/robotImport/** -->
# Robot import — the importer engine, its frames and its budgets

The contract is `docs/robot-import-plan.md` (§3 and §4 bind). This guide is the engine's half:
which frame every number is in, how detection works, and what each budget is. Read it before
touching `src/robotImport/**`.

## Layout and the lazy boundary

| file | imports | chunk |
|---|---|---|
| `types.ts` | nothing but types | main-safe |
| `drive.ts` | `src/sim/drivetrain`, `src/config` | main-safe, DOM-free |
| `geometry.ts` | `src/types` | main-safe, DOM-free |
| `shareFile.ts` | nothing | main-safe, no three |
| `library.ts` | `storageKeys`, IndexedDB `decodesim.robots` | main-safe, no three; a READ never creates the database (`dbExists`) |
| `libraryIds.ts` | types only | main-safe (the robot page and the lobby read it) |
| `engineLoader.ts` | one dynamic `import()` | main-safe |
| `engine/**` | three.js, loaders, meshopt, occt | **lazy**: `engine/importerEngine.ts` is the one entry |

- three.js may be imported only under `src/games/biobuzz/scene/` and `src/robotImport/engine/`.
  Every caller reaches the engine through `loadImporterEngine()` (`engineLoader.ts`), the one
  dynamic specifier. The RENDER lane (`scripts/smoke-biobuzz/render.ts`) fails a static import of
  `engine/` from outside it, a second specifier, or three.js anywhere but the two zones.
- `engine/stepReader.ts` is reached by its own `import()` from `engine/load.ts` and starts the STEP
  worker (`stepWorker.ts`), which reads the dropped file itself and runs occt in workers of its own
  (`occtWorker.ts`, a worker made inside a worker, which Vite bundles as its own chunk), so the glue
  and its 7.6 MB wasm (a Vite `?url` asset) are fetched only when a STEP file is dropped, and a
  420 MB STEP neither freezes the page nor passes through it. occt-import-js is LGPL-2.1, a
  devDependency like three (bundled, never installed on the server); it needs a credit on the
  Contributors page. See "Real CAD" below for what the STEP worker does with a big file.
- Two lazy zones share three.js, so once both are reachable Rollup hoists three (with GLTFLoader,
  the meshopt decoder and BufferGeometryUtils) into a shared chunk named after one of its modules.
  `bundleaudit` bills it to `scene` by its `WebGLRenderer` marker and routes `renderScene-*.js`,
  `importerEngine-*.js` and the STEP files by filename. Until a screen imports the loader, a
  production build drops the engine; `npm run bundleaudit:importer` builds with the loader as an
  extra entry and audits that.
- **The engine runs two more workers** (see "Workers" below): `importWorker.ts` and
  `measureWorker.ts`, each its own chunk (route `importworker`, by filename, with the import worker's
  lazy `meshoptDecoder-*.js`). A worker is made only as `new Worker(new URL('./x.ts',
  import.meta.url), { type: 'module' })` inside `engine/` (a smoke check pins the form), and what it
  runs touches no DOM (another check).

## Frames — every number is in exactly one of these

1. **Source**: whatever the file says. glTF is metres, +Y up, front +Z (glTF 2.0 §3.4). STEP is
   read by occt in millimetres (`linearUnit: 'millimeter'`). 3MF carries a `unit` attribute.
   STL, OBJ and PLY carry no units.
2. **Model frame**: inches, +x front, +y left, +z up, floor at z = 0, x/y origin at the centre of
   the footprint's bounding box. Independent of the wheels, so it does not move when a wheel is
   dragged. Wheel overrides and mechanism placements made in the editor are stored here.
3. **Robot-local frame** (plan §3.1): the model frame shifted so the origin is the wheelbase
   centre (the mean of the four wheel contacts; the footprint box centre when wheels are unknown).
   `ImportedRobot` is in this frame. `modelToRobot` / `robotToModel` convert.
4. **Stored mesh** (the library GLB and the share file): glTF conventions, so any viewer shows it
   upright, life-size and facing the viewer — metres, +Y up, +Z front, +X left, origin at the
   robot-local origin on the floor. `STORED_MESH_TO_ROBOT` (column-major 4×4, `types.ts`) maps it
   to robot-local inches: x = z/0.0254, y = x/0.0254, z = y/0.0254. It is a pure rotation and
   scale (det > 0), so winding is preserved.
5. **Top image**: 512 px square, transparent, front = image up, robot left = image left.
   `topImageFrame(hull)` gives its centre (the hull's box centre) and inches per pixel (the larger
   box side plus 0.5 in a side, over 512). A pixel (u, v), origin top-left, is robot-local
   x = cx + (256 − v)·s, y = cy + (256 − u)·s. Renderers recompute it from `spec.imported.hull`.

## Detection

- **Units**: the robot's largest extent should be near 15 in. Every candidate unit (mm, cm, m,
  in, ft) is scored by |ln(extent/15 in)|; the format's own unit gets a 0.35 head start. STEP and
  3MF units are read, not guessed. A glTF exported in millimetres is 450 "metres" long and loses.
- **Up axis**: the format default (glTF +Y, everything else +Z) plus a geometric tiebreak over all
  six signed axes. A robot stands on its wheels, so the right "down" has (a) floor contacts that
  spread across the footprint, (b) a centre of mass inside the support polygon, and (c) almost no
  flat, downward-facing area at the very bottom. A robot on its side fails (b) and (c).
- **Front** (`detectFront`, `FrontDetection` in `types.ts`): the CAD front view (−Y front when Z is
  up, +Z front when Y is up) unless the geometry says otherwise with confidence. Three cues vote
  along the footprint's two axes, weighted 1 / 0.5 / 0.35: an INTAKE (geometry no higher than
  3 in that reaches past the outermost wheel further at one end than the other, ¾ in dead band,
  all of the vote at 2¼ in, scaled by how much of the robot's width its outermost 1.5 in covers),
  the WHEELS set back from one end (wheelbase centre against footprint centre, ½ in dead band),
  and the MASS (surface-area centre) toward the other end. The confidence is the strongest axis's
  vote less the other axis's; at 0.6 and over the front is DETECTED and the editor turns the robot
  to it as the file is read ("Detected from the intake"); under it the front is ASSUMED, the Model
  step says "Assumed: the CAD front view", and Review carries a note (`front-assumed`, Fix → the
  Turn buttons) until the player turns it. A saved robot's stored mesh, and a setup that names a
  yaw, are never re-detected. Measured: the synthetic robot (4- and 6-wheel, facing either way) is
  found in all 24 orientations; the stress robots in every orientation whose up axis is found;
  goBILDA's BIOBUZZ starter bot (a front roller intake) in all 24, confidence 0.65; goBILDA's
  DECODE and REV's DECODE starter bots (no intake, launcher at the front) are ASSUMED in all 24
  (confidence 0.12, and 0.09–0.30) and their CAD front is their real one. Never wrongly detected
  on any of them (measured on the stored meshes the editor saved, turned through all 24
  orientations).
- **Floor contacts → wheels**: vertices within 0.15 in of the floor (0.5 in if that finds fewer
  than four wheels), joined when within 1 in of each other OR when a mesh edge runs between them
  inside the slab. The edges matter: a cylinder's contact line is two cap vertices a wheel-width
  apart (one wheel, not two), and an intake roller's is one edge a robot-width long (one long
  contact, not two wheels). Clusters longer than 3.5 in are an intake or a skid. Four or more wheel
  clusters → the four corner ones (extremes of ±x ± y after normalising by the layout's extent);
  fewer → a reason, and the rectangle default. `detectWheels` reports them as found;
  `finishMeasure` lines them up (below).
- **Footprint hull**: monotone chain on every vertex's (x, y), reduced to ≤ 16 vertices by a
  MIN-MAX search (binary search on the tolerance; farthest-reach walks from every start), an inner
  approximation whose measured maximum deviation is reported. Greedy removal alone is a local
  optimum (a 64-gon circle cut to 16: 0.26 in, against 0.17 for even spacing). Then quantised to
  1/64 in and re-hulled so `coerceImported` leaves it unchanged.
- **Measured on a simplification.** The engine simplifies once per file, in the source frame
  (simplification commutes with rotation and uniform scale), and measures the result: at Light the
  stored 250k, at Full a copy of about `MEASURE_TRI_BUDGET` (250k) that keeps every body ("Full
  detail" below), so the measurement, the part finders and picking cost what they did while the
  preview, the bake and the match get every triangle. At 100k, against measuring every triangle of the stress robots (0.5,
  1.5 and 3.9 M), that cost at
  most 0.07 in of hull, 0.13 in of wheel centre and 0.01 in of height, with the same units, up axis
  and band count (`stressbench.ts --full`); `npm test` holds the 0.5 M robot to 1/16 in, 0.15 in and
  0.02 in.
- **Two halves, cached** (`measureSession.ts`). `orientParts` (units and up detection, the model
  frame, the raw hull, floor contacts and wheels, bands) depends only on the units, up axis, yaw and
  band switch; `finishMeasure` (the hull cap, manual wheels, the origin, the band shift, the checks)
  on the rest. `measureParts` is the one composed with the other, and the engine keeps one
  orientation per key, so a wheel drag or a drivetrain edit re-runs only the finish (under a
  millisecond) and the model-frame arrays keep their identity (the preview does not rebuild).
- **Colours are linear RGB** everywhere (`MeshPart.color`, three's working space, glTF's
  `baseColorFactor`). occt already returns linear: converting its colours again darkens them.
- **Height bands** (BIOBUZZ 3D): triangles are clipped into 0.5 in slices, each slice hulled, and
  the slices split into ≤ 3 contiguous bands by DP on the volume a band's hull wastes. Bands are
  emitted only when they save ≥ 5 % of the single prism's volume. Each band hull ≤ 12 vertices.

## Budgets

- **Full** (`FULL_DETAIL`, `triBudget` 0, the default) keeps every triangle the reader makes (less
  the degenerate ones the weld drops); **Light** (`LIGHT_TRI_BUDGET`) simplifies to 250,000 with one
  error bound for the whole robot (`engine/simplify.ts`, "Mesh quality"). A setup from before reads at
  the budget it names (250k was Standard, 400k Maximum); nothing caps a budget from above. One
  material per source colour; textures are dropped.
- Stored GLB ≤ 128 MiB (`MAX_MESH_BYTES`; 4 MiB while every robot was 250k), written by `engine/storedGlb.ts` with
  `KHR_mesh_quantization` and `EXT_meshopt_compression`, both required. Positions are 14 bits per
  axis over each mesh's largest side, dequantised by the mesh's node (a translation and one uniform
  scale). Normals are creased at 40° and stored as 8-bit octahedral. `_BODY` is unsigned 32-bit.
  Indices are 16-bit below 65,535 vertices. The encoder is meshoptimizer's (a lazy chunk, fetched on
  a Save).
- Measured on the REV and goBILDA kits at 250k: 8.5–9.5 bytes a triangle against GLTFExporter's 51,
  so 250k is 2.0–2.3 MiB and 400k about 3.6 MiB. Quantisation moves a vertex 0.022 mm at most;
  normals are off by 0.3° on average, 1.2° at most. Dense CAD packs tighter: at Full, REV's 2.31M
  are 10.2 MB (4.6 bytes a triangle) and goBILDA's BIOBUZZ 5.66M 27.0 MB (5.0). If a bake still
  comes out over the cap (about 14M triangles), the triangle target drops in proportion and the mesh
  is simplified again.
- Every reader sets three's meshopt decoder: the 3D scene's loader, `parse.ts` (an edit of a saved
  robot, a share file) and `liteMesh`. The scene turns positions and normals back into Float32 on load
  (`floatAttribute`, `renderImported.ts`, straight off the typed array), because ANGLE on D3D11 draws
  quantised attributes slower: four 250k robots took 2.21 ms a frame quantised and 1.31 ms as float
  (RTX 4070 Ti, 1080p). It drops `_body` there as well, which the scene never reads.
- A float stored mesh saved before still loads as it did, and is never re-baked.
- A share file is the stored mesh with the setup in its JSON, so it is compressed too. Every build
  with the importer opens one, since `parse.ts` has set the meshopt decoder from the first engine. A
  glTF viewer needs both extensions; three.js and Babylon.js read them.
- `ImportedRobot` ≤ 2 KB JSON (16 + 3 × 12 hull vertices at 1/64 in is about 1.2 KB).
- The drivetrain numbers shown are `driveParams`/`pushForce` of the spec that will be saved. The
  equivalent rpm is motor free rpm ÷ gearbox ÷ external ratio × (wheel mm / 104), because the sim
  models wheel rpm at a 104 mm wheel (`SPEED_PER_RPM`). Catalogue sources are cited in `drive.ts`.

## Workers: nothing that scales with the triangle count runs on the main thread

A real FTC export is 1–5 M triangles (every screw thread, chain link and gear tooth). Measured
before this rule, a 3.9 M-triangle STL froze the editor for one 3.6 s task and a units click cost
110–200 ms. So, in the editor:

| work | where |
|---|---|
| parse GLB, glTF, STL, OBJ+MTL, PLY, 3MF (and a zip holding one); merge by colour; weld; simplify; crease | `importWorker.ts`, one per import, terminated when it answers |
| STEP (and a zip holding one): read, check, split, occt | `stepWorker.ts` and its `occtWorker.ts` pool, then the parts go to the import worker for the rest |
| 3MF: three's loader | the import worker, with `miniDom.ts` as its `DOMParser` for the length of the parse (a worker has none); the main-thread fallback keeps the page's own |
| a new orientation (units, up axis, turn) | `measureWorker.ts`, one per model in the editor, holding a copy of the prepared model |
| the light half of a measurement, the model-frame arrays | main thread, from the worker's small `OrientedMeasure` (`toModelFrame` rebuilds the arrays bit for bit) |
| the bake's mesh half: the robot-local frame, the split into moving parts, the GLB export and its refits | the import worker (`bakeModelHere`: `bakeScene.ts`, `bakeMesh.ts`, `storedGlb.ts`); the two pictures need WebGL and stay, with `compileAsync` first |
| a share file added to the library | the import worker, at a budget no file reaches (nothing simplified, nothing measured apart); the pictures stay |
| a room's lighter mesh (`liteMesh`) | the import worker (`liteMeshOff`, a lazy `lite-*.js` there); it was on the main thread, 0.3 s from a 69k float mesh and 0.8 s from a 250k one (Node) |

- **Identical outputs.** Every move is the same code in another thread, and `npm test` holds each to
  the old result bit for bit: the halves against `measureParts`, `toModelFrame` against the arrays
  measured on, the streamed STL reader against three's loader, the weld without its three
  quantised arrays against the weld with them, the direct `partsFromObject` read against
  `Vector3.applyMatrix4`. Arrays cross TRANSFERRED; a buffer listed twice is a `DataCloneError`, so
  `partBuffers` dedupes.
- **The streamed STL reader** (`parseBinaryStlWelded`) reads a binary STL in 3.2 MB slices and merges
  bit-identical vertices as it goes, so a 184 MB file never sits in memory un-indexed; an ASCII STL,
  a colour STL or one whose length disagrees with its count goes to three's loader.
- **Cancel terminates** the import's workers (occt and meshopt cannot be interrupted from inside);
  the promise rejects with an `AbortError`, which the editor shows nothing for. A new drop cancels the
  last one. Measured, the core goes idle within 0.25–2 s of the click.
- **While a new orientation is measured** the editor shows the last measurement of this model and
  holds what would act on it (default placements, a wheel drag, Save, Test drive, Export); past
  300 ms the panel title says "Measuring…".
- **Fallbacks.** No `Worker`, or a worker script that does not load: the same steps on the main
  thread (`load.ts`, `normalise` computing the orientation itself). `npm test` runs those paths,
  which is the same code the workers run. A saved robot's stored mesh (a re-open) and a share file go
  through the import worker like any other file: a Full robot's is tens of MB. The dev harness uses
  the main-thread `loadModel`.
- **Memory.** The renderer's peak on the 3.9 M STL went from 1021 MB to 763 MB; what is left is
  meshopt's working set for a 3.9 M-triangle part, in the import worker, returned when it is
  terminated. The main thread holds the prepared model and up to six orientations of its measured
  copy; at Full also every triangle (`PreparedModel.full`) and that in the newest orientation's model
  frame only (`NormalisedModel.shownParts`; an older orientation lets its copy go). The measure worker
  gets the measured copy alone. Two models keep a measure worker (`KEEP_MODELS`), the oldest is
  released.
- **A GLB is merged as it is read** (`mergedPartsFromObject`): the colours are grouped first, each
  group's arrays allocated at their final size, every mesh instance written straight into its group,
  and a geometry's arrays let go after its last instance; the file's bytes and the loader's buffer
  views go out of scope before the merge starts. The import worker then hands its loaded parts to
  the simplifier to CONSUME (`simplifyModel(…, { consume: true })`): each is released once welded.
  Both are pinned to the old outputs bit for bit (`robot import (real CAD)`). Renderer peak, same
  probe and machine, before → after: 80 MB flat GLB (3.85 M) 937 → 830 MB, 35 MB flat GLB 584 →
  448 MB, 12 MB shared-mesh GLB (3.85 M) 811 → 627 MB, 184 MB STL 763 → 769 MB. What remains on the
  80 MB file is three's GLTFLoader copying every buffer view out of the file while both are held,
  and meshopt.

Measured 2026-10-02 (`scripts/robot-import/stressprobe.cjs`, production build, offscreen Electron,
software GL, Ryzen 9 7950X; the stress robots from `scripts/robot-import/stress.ts`):

| model (file MB) | import: longest task, ms | import: blocked total, ms | first frame, ms | peak renderer MB | Units/Up/Turn: longest task / settled, ms | wheel nudge: longest / settled, ms | drivetrain pick, ms | Save: longest task, ms |
|---|---|---|---|---|---|---|---|---|
| 0.47 M GLB (5.7) | 237 → 0 | 435 → 0 | 752 → 625 | 323 → 260 | 159/198 → 0/198 | 104/131 → 0/32 | 72 → 0 | 0 → 0 |
| 0.47 M GLB flat (14.2) | 236 → 0 | 433 → 0 | 777 → 606 | 340 → 327 | 178/213 → 0/167 | 96/115 → 0/31 | 70 → 0 | 0 → 0 |
| 0.47 M STL (22.5) | 324 → 0 | 570 → 0 | 811 → 798 | 362 → 267 | 109/131 → 0/165 | 121/143 → 0/34 | 77 → 0 | 120 → 0 |
| 0.47 M STEP (8.6) | 108 → 0 | 182 → 0 | 7616 → 7363 | 952 → 965 | 68/90 → 0/115 | 53/66 → 0/33 | 0 → 0 | 0 → 0 |
| 1.55 M GLB (8.1) | 897 → 0 | 1157 → 0 | 1606 → 1260 | 477 → 434 | 172/197 → 0/180 | 111/132 → 0/32 | 74 → 0 | 104 → 0 |
| 1.55 M GLB flat (34.7) | 875 → 0 | 1161 → 0 | 1681 → 1326 | 508 → 510 | 198/233 → 0/233 | 83/115 → 0/34 | 87 → 0 | 94 → 0 |
| 1.55 M STL (74) | 1281 → 50 | 1532 → 50 | 1893 → 1944 | 549 → 430 | 127/150 → 0/183 | 135/164 → 0/33 | 73 → 0 | 103 → 0 |
| 3.85 M GLB (12.4) | 2326 → 0 | 2577 → 0 | 3311 → 2660 | 795 → 811 | 168/198 → 0/197 | 110/128 → 0/34 | 79 → 0 | 118 → 0 |
| 3.85 M GLB flat (79.7) | 2747 → 50 | 3008 → 50 | 3969 → 3347 | 791 → 934 | 137/165 → 0/197 | 104/132 → 0/34 | 71 → 0 | 97 → 0 |
| 3.85 M STL (183.8) | 3569 → 0 | 3843 → 0 | 4408 → 4389 | 1021 → 763 | 120/143 → 0/197 | 152/179 → 0/33 | 79 → 0 | 91 → 0 |

Before → after, per stage (long tasks are the browser's, 50 ms and over). The import's work all left
the main thread: what remains is two 50 ms tasks at the first frame, and the measure worker's
answer, 115–230 ms after a Units, Up or Turn click, with nothing blocked meanwhile. A wheel nudge
or a drivetrain pick re-runs only the light half. A Save no longer blocks either. Cancel: before,
the click waited behind the frozen page (up to the longest task, 3.6 s) and a STEP read ran to its
end; now it is handled at once and the workers are terminated (the core is idle within 0.25–2 s,
the time this Electron takes to stop even a bare busy-loop worker). Memory: the streamed STL reader
cut the STL peaks by a quarter; a GLB's peak was about what it was (18 % higher on the 80 MB flat
one: the worker held the buffers the main thread did) until the GLB was merged as it is read (the
"Memory" bullet above: 937 → 830 MB on that file), and a STEP's is occt's.

**At 250k triangles** (2026-10-03, the same probe with hardware GL, the 1.55 M GLB; ede417c4 at
100k in brackets): the first frame at 4.75 s (4.44); Units, Up and Turn settle in 310–490 ms
(210–290) with two main-thread tasks of 58–80 ms each (none over 50), the measure worker's answer
and the preview rebuilding its mesh; a wheel nudge settles in 30–33 ms with no long task (59–65,
once the moving parts stopped being re-measured on a nudge, `measureSession.ts`); the orbit holds
60 fps; Save settles in 445 ms (874) with one 114 ms task, the two pictures. Real CAD: REV's STEP
gives 247,949 triangles in 85 s (95 s for 81k), goBILDA's BIOBUZZ zip 247,563 in 196 s (195 s);
simplifying to 250k is no slower than to 100k (the error-bound ladder stops sooner). One task grew
that is worth moving: BIOBUZZ's first measurement has a 409 ms main-thread task (160 ms at 100k),
mostly the one-time roller search (`findRollerGroups`, 164 ms in Node at 250k, 43 ms at 72k).

## Real CAD: big STEP files, zips, files cut off

Measured on the vendors' own starter bots (REV's DUO DECODE bot, a 125 MB STEP; goBILDA's DECODE
mecanum and BIOBUZZ bots, 390 and 420 MB STEP published as 58 and 66 MB zips; goBILDA's DECODE
skid-steer STEP, published cut off). The files are not committed (goBILDA publishes no licence,
REV's is CC BY-NC-SA); `scripts/robot-import/realcadprobe.cjs` drives the real editor with them.

- ⚠️ **occt's heap stops at 2 GB, and running out does not fail.** occt-import-js 0.0.23 is built
  with `getHeapMax` = 2 GB, and its STEP reader keeps the whole entity graph there: 23–48 bytes of
  heap per byte of STEP text, measured. On REV's 125 MB file the heap hit 2 GB, 160,811 allocations
  failed inside BRepMesh, each was caught per face, and `ReadStepFile` returned `success: true`
  with 1,334 meshes, 118,734 faces and ZERO triangles. Deflection, units and parameters change
  nothing. So: faces with no triangles is how a read says it ran out (`stepToParts` counts them).
- **Up to 8 MB a STEP is read whole** (`DIRECT_MAX_BYTES`, `STEP_PARAMS`, bounding-box ratio), in
  one occt worker. A whole read that comes back with faces and no triangles is read again in pieces.
  It was 20 MB: past 8, pieces in parallel are faster (a 12.6 MB file: 10.0 s whole, 4.2 s in pieces).
- **Past 8 MB it is read in PIECES** (`stepSplit.ts`). One pass indexes every entity (its bytes,
  its type, its references and whether each sits in a list): 0.45 s and 1.8 M entities for REV,
  1.1 s and 4.1 M for goBILDA's 390 MB. A ROOT is every non-structural item of a shape
  representation (a solid, a shell model, a curve set); the SKELETON is everything no root reaches
  (products, occurrences, placements, colours: 1.3 and 1.5 MB). Each piece is a complete STEP file:
  the header, the whole skeleton, and about `pieceBytesFor` (3–6 MB, two a reader) of roots, packed in file
  order. A shape representation lists only its piece's roots, and a styled item on something left
  out is left out with it (a presentation list just loses it). A root over half a piece is split
  into its FACES (goBILDA's 99 MB gearbox body has 3,520): the solid and its shell come along as an
  open shell listing the piece's faces (`openUp`), and each face gets a copy of the solid's style,
  because occt heals a shell whose faces do not touch into new shells the colour no longer finds.
  A split solid's faces get pieces of their own (see the colours below).
- ⚠️ **occt does not find a body's colour when the body is not its part's whole shape.**
  occt-import-js looks each solid up at its PLACED location, and that finds only a part made of one
  solid. Every body of a multi-body part placed in an assembly, and every shell occt makes of a split
  solid's faces, came back nameless and grey, in a whole read as in pieces, and the face style copies
  do not help there. Cutting a body list (the size filter, a piece boundary) has nothing to do with
  it: the whole 13-body part reads grey too. Measured: 31 % of goBILDA's BIOBUZZ bot by area (every
  black wheel, the intake rollers), 11 % of REV's. So every occt read gets a colour hint
  (`colourHint`, `wholeHint`; `lostColours` in `stepConvert.ts`): for each multi-body part, its
  bodies' face counts and styled colours in list order (occt meshes a part's solids in that order,
  then its shells, once per placement), and for a piece of one split solid's faces, that solid's
  colour for every mesh left grey. A grey mesh takes a colour only when every best match of the face
  counts gives it the same one, so two parts with the same counts and different colours stay grey.
  A mesh occt named or coloured is never touched, and the colour is converted to linear as occt
  does it (bit for bit). After, both kits read 0 % grey; BIOBUZZ 38 → 45 pieces, REV 11 → 13, read
  time the same within noise (Node, three occt threads: 173 → 160 s and 67 → 69 s).
- **Pieces mesh at an ABSOLUTE 0.5 mm and 0.5 rad** (`STEP_PIECE_PARAMS`): a bounding-box ratio is
  per top-level shape, and a piece's is a share of the robot. Meshing is not the cost: 2 mm and 1 rad
  cut a 24 MB piece's 29.3 s to 27.4 s. occt reads about 1 MB of STEP a second.
- **A pool of occt workers** reads the pieces, biggest first (`poolSize`): every core but two, up to
  six on a device that reports 8 GB (eight with 16 cores), three on 4 GB, two on 2 GB. Each keeps its
  occt (and its heap's high-water mark) between pieces. The read is CPU-bound and splits evenly
  (REV: 3 readers 64.6 s, 6 36.0 s, 8 30.5 s, 13 22.6 s, the summed occt time unchanged), so memory is
  the limit: a reader peaks at 627 MB on 12 MB pieces and 368 MB on 6 MB ones, which is why pieces
  are 6 MB at most (`STEP_PIECE_BYTES`; 24 MB at first, then 12). The skeleton every piece re-reads
  costs occt ~0.26 s a piece (4–6 % of the read), so it is not trimmed per piece.
- **Planning is string-light.** `planPieces` sized parts by parsing their points with
  `String.fromCharCode(...bytes)`, a spread through the iterator protocol per byte: 6.7 s of a 420 MB
  file. `fromCharCode.apply` (`chars`) gives the same strings: 1.7 s, the plan bit-identical.
- **Parts under 16 mm across are left out of a file read in pieces** (`MIN_PART_MM`): screws, nuts,
  washers. A part's size is the box of the points ON it (B-rep vertices, B-spline control points, a
  whole circle's centre ± radius), not of every point it names: a cylinder's placement can sit
  metres along its axis, and REV's bot has 1,476 arcs of a 2.27 m circle on one 40 cm part. The
  Review step says how many were left out (the reader's notes, `EditorDoc.notes`). Left out: REV
  50 of 203 bodies (12.5 MB of 125), goBILDA DECODE 70 of 192 (14.1 MB), BIOBUZZ 73 of 302 (13.3 MB).
- **Progress**: the bar follows the pieces (bytes read over bytes to read), and once a quarter is
  read the line says how long is left ("Reading …, about 2 min left…"). Any earlier, the pieces still
  in flight in the other workers make the guess run long: "4 min" 20 s into REV's 70 s read.
- **The pieces' triangles are the whole read's.** `npm test` reads the fixture whole and in pieces
  (by whole parts, and with every solid split into faces) and compares the triangles, colours
  included; every piece re-indexes with no dangling reference.
- **The STEP worker reads the FILE** (a `File` is posted, never its bytes), so a 420 MB STEP never
  passes through the page. Caps: a STEP, or a STEP in a zip, up to 1 GB (`MAX_STEP_BYTES`); meshes
  400 MB; a zip 1 GB.
- **A zip is opened through its directory** (`zip.ts`: the end record and the central directory, with
  ZIP64) on the main thread, a few KB from the file's tail, to see which model is inside (the same
  priority as dropped files; a .gltf brings its .bin, an .obj its .mtl). The model is inflated where
  it is read, in 4 MB slices of the compressed data into a buffer of its stated size: in the STEP
  worker for a STEP (390 MB in 1.8 s), in the import worker for the rest.
- **A file cut off is said before occt sees it** (`checkStepText`: a STEP opens with
  `ISO-10303-21;` and ends with `END-ISO-10303-21;`): "Couldn’t read …: the file is cut off …".
  Every STEP failure ends with `EXPORT_HINT`, the mesh export menu by menu for Onshape, Fusion,
  SolidWorks and Inventor. `step-reader` (the reader did not load) is the only one with Try again.

| starter bot (file) | read | longest main-thread task | renderer peak | triangles in → kept | footprint (L × W), height | wheels (corner four) | front |
|---|---|---|---|---|---|---|---|
| REV DUO DECODE (125 MB STEP) | 69 s | 0 ms | 2.6–2.7 GB | 2.31 M → 98.7k | 16.81 × 16.53 in, 15.31 in | ±5.67, ±7.1–7.5 in | assumed (CAD front = launcher) |
| goBILDA DECODE mecanum (58 MB zip, 390 MB STEP) | 155 s | 0 ms | 2.7 GB | 6.24 M → 97.6k | 17.25 × 17.77 in, 17.80 in | ±4.70, ±8.15 in | assumed (CAD front = launcher) |
| goBILDA BIOBUZZ (66 MB zip, 420 MB STEP) | 158.9 s | 0 ms | 2.48 GB | 5.66 M → 96.1k | 17.78 × 16.78 in, 12.02 in | ±5.72, ±7.8–7.9 in | detected from the intake |
| goBILDA DECODE skid-steer (36 MB zip) | 1.1 s | 0 ms | 0.53 GB | the file is cut off, said so | | | |

Re-measured 2026-10-03 with the pool, 6 MB pieces and the faster plan (32-thread, 63 GB machine, so
eight readers; offscreen production editor, the whole import from drop to measured): REV 85 → 34.1 s
(renderer peak 3.4 GB), goBILDA BIOBUZZ 170.1 → 53.9 s (unzip 1.9 s, index and plan 2.7, read 43,
simplify 5.2, measure 0.7; peak 3.5 GB, was 2.6).

Units mm (declared), up +Z, four wheels found, Review clean on all three; each test-drives. Against
what the vendors publish: REV's frame is 420 mm extrusions across (measured 420 mm wide) on 408 mm
C-channels (427 mm long overall); goBILDA's DECODE bot has a shortened wheelbase on 104 mm mecanum
wheels (239 mm measured); all three fit the 18 in cube.

## A fixed launcher's facing

`ImportedMech.shooterYawDeg` (plan §3.1) is the direction a TURRETLESS launcher fires, degrees CCW
from robot forward: whole degrees wrapped to (−180, 180], kept only beside `shooter`. A direction,
so the model↔robot frame shift (`mechModelToRobot` / `mechRobotToModel`) copies it unchanged. A
game's handle carries `facingDeg` when the build fires along one (DECODE `launcher: 'fixed'`,
BIOBUZZ's `fixed` kind); the Mechanisms step then draws a ray from the point and a second handle
4 in out along it (`shape: 'aim'`), dragged round the point, plus a Facing field (15° steps). Home
puts the game's pre-fill back (DECODE forward, BIOBUZZ its edge).

## Moving parts

`ImportSetup.motion` (`MotionGroup[]`, `src/robotImport/motion.ts`) says which CAD bodies move in a
match: `wheel`, `roller`, `flywheel` spin about their own axle, `turret` turns about a vertical axis,
`ramp` (BIOBUZZ's deployable intake) and `fold` swing about a hinge, and the GENERIC joints `spin`,
`swing` and `slide` cover what those do not (below). It is FRAME-FREE (body ids and choices, never
positions), so a units or yaw change keeps it. Absent = never looked for: the editor looks once, and
Find moving parts again on demand, among the bodies no row has (each marked `found` until edited):
- the drive wheels (`findWheelGroups`: every body wholly inside each wheel's cylinder at a floor
  contact, of which `turnsWithWheel` keeps what turns, below);
- the intake rollers (`findRollerGroups`: a round body near an intake span's edge, within 4 in of it
  and under 10 in, grown to its axle), its axle ALONG the edge or UPRIGHT (side rollers);
- flywheels (`findFlywheelGroups`: round discs with a level axle within 5 in of the placed launcher,
  the two largest axles);
- a turret on a turreted build (`findTurretGroup`: the largest round, upright ring under the launcher,
  1.5 to 6 in in radius, and what stands on it);
- a part the file shows deployed (`findDeployedGroup`: when the model runs past 18 in toward an
  intake edge, the bodies past that line and what is mounted on them), as BIOBUZZ's `ramp` on a ramp
  intake, else a `fold`. The owner's "it says the robot is too big" case, found for the player.
`[]` = none.

- **Bodies.** `MeshPart.body` is a per-vertex id: one per mesh instance from a reader, one per STEP
  solid, the connected pieces when a file has only one. Weld never joins two bodies; weld, compact,
  crease, merge and simplify all carry it. The stored GLB writes it as `_BODY` (unsigned 32-bit, one
  per vertex; a float mesh saved before has 16-bit where it fits, and the relay's validator allows
  both), so an edit of a saved robot can pick parts again. The lighter relay mesh drops it.
- ⚠️ **A body that is several LUMPS gets an id per lump** (`splitLumps`, in the simplifier). An
  exporter can put a channel and the gear beside it in one mesh or one multi-lump solid, and picking
  works on bodies, so they could only move together (owner, 2026-10-03). Lumps are joined across
  colour groups by position (a two-colour wheel stays one); the first keeps the id, so a one-lump body
  keeps its id and a saved robot's rows still name the same parts. REV's kit: 7 of 2,150 solids.
- ⚠️ **What turns with a wheel** (`turnsWithWheel`; owner: "the motor or the motor cover/shield spins
  with the wheel sometimes", and on goBILDA's kit frame screws beside the axle did). The wheel's WIDTH
  is the along-axle span of its ring: bodies CENTRED on the axle near the largest radius (a tyre, a
  rim, a mecanum's side plates); a shield or pulley beside it is centred and big too, so the ring is
  the bodies within 85 % of the largest. A body on the axle must overlap that width and stand out of
  it by at most 0.6 in (a hub does; a motor, a bearing block, a shield do not). A body off the axle
  must lie within it, and one smaller than a fastener lying square to the axle must be tangential (an
  omni roller), not pointing toward the axle (a frame screw). Measured on goBILDA's kit: the rear
  wheels 12–13 → 9 bodies (inboard bearings, collars, a frame screw out), the front 78 → 64.
- ⚠️ **THE MOVING PARTS STEP** (2026-10-04, owner: "UI is very unintuitive"). Moving parts were the
  bottom of a long Mechanisms page, every row carried Pick parts / Reverse / Remove and two link
  menus, ten Add and Find buttons sat under them, and the preview tinted every part one colour. Now
  they are a step of their own (Model · Drivetrain · Mechanisms · Moving parts · Review). SELECTING
  a row is editing it: its parts tint blue, a click in the preview adds or takes out parts, and its
  settings open under it (turns the other way, the hinge or joint fields, Geared to, Rides on,
  Remove); hovering a row tints it without selecting. One "Add a moving part" menu replaces the Add
  buttons. Find moving parts looks again for every row still `found` and keeps the edited ones
  (`keepEditedMotion` moves their links; a wheel row the player edited keeps its corner). Each step's
  preview draws only what that step is about, with a legend under the cameras.
- **Picking** (the Moving parts step, a selected row): a click on a wheel takes what lies in its cylinder and
  turns with it; on a roller, flywheel or spinning part, everything on its axle (`coaxialBodies`),
  where a body bigger than a fastener must be ROUND about the axle (a channel the shaft runs along is
  centred on it too, and has corners) and a motor-sized cylinder past the end of the rest (the motor
  driving it) stays; on anything else, the smaller bodies inside its box (`mountedBodies`: a plate's
  hardware). Shift takes one body. A body is in one group at a time.
- **Generic joints** (`JOINT_ROLES`), for a mechanism the named roles do not cover: `spin` turns
  continuously (turns a second), `swing` to an angle and back (an arm, a kicker; degrees), `slide`
  along a line and back (a lift, an extension; inches). Each is moved by one of the robot's signals
  (`MotionDrive`: intake, launcher, each shot as a pulse, ramp, driving speed, always), about or
  along a robot axis or a picked part's (`axis: 'part'`, `axisBody`: its round axle, a slide rail's
  long side), and a swing pivots on that part's axle or, without one, at its own end nearer the
  robot's middle. Any spinning or generic part can be GEARED to another (`follows`: its value times a
  ratio, a gear train, a belt, a cascade's second stage) and RIDE on another (`rideOn`: an arm on a
  slide). A chain or a gearing that comes back on itself is cut where it closes. Measured as
  `MotionPart` (`drive`, `amount` in turns a second, radians or inches, `follows` by part index) and
  stored with an `id` per node and `follow: { id, ratio }`; an older viewer reads a joint's role as
  unknown and draws it where it is. Removing a row renumbers what named the rows after it.
- **A hinged part the file shows DEPLOYED is measured FOLDED.** `planFolds` runs in the measurement's
  rotated frame before the box, hull and contacts: the hinge is level, square to the direction the
  part sits out from the robot, through its innermost point; it folds up until its far end is over
  the hinge (or by `foldDeg`). That is how a robot whose CAD has its ramp out fits the 18-in start.
  A spinning part whose box centre is inside the hinged part's box rides on it and folds with it.
  `toModelFrame` re-applies the folds at the same step, so the main thread rebuilds the worker's
  model frame bit for bit. Use the box centre, not the vertex mean, for "inside": a fanned cap puts
  half a cylinder's vertices on one rim point.
- **Saved folded.** The stored mesh is in the starting pose, so Save and Export rewrite a deployed
  hinge as `filePose: 'folded'` with the measured `deployDeg` (`motionAsStored`). A folded part's
  hinge is at its foot (the lowest band), which is where the deployed rule put it, so a reopened
  robot hinges in the same place (smoke: within 0.6 in).
- **Stored GLB.** Each moving part is a node at its pivot, its geometry relative to it, with
  `extras.dsim` (`StoredMotion`: role, unit axis, radius, deploy angle, wheel corner, and for a joint
  its id, drive, amount and follow); a rider is its carrier's child. A viewer that ignores it draws
  the starting pose. `readStoredMotion` validates every field, since a relayed mesh is another
  player's file.
- **Animated** in BIOBUZZ 3D by `poseImportMotion` (`renderRobots.ts`), off the same state the
  standard parts read: a wheel at its contact patch's speed (mecanum through its 45° rollers, swerve
  along its pod), a roller while the intake runs, a flywheel at `flyRpm`, a turret at its yaw, a
  ramp off `bbRampOut`, a generic joint off its drive (`jointLevel`; a swing eases over 0.3 s, a
  slide over 0.5 s), a geared part as its leader times the ratio. Drawn spin is capped at 26 rad/s,
  past which a spoked wheel strobes. The editor's preview has Play for the same, with fixed rates.

## Mesh quality

Measured 2026-10-03 on the REV and goBILDA starter-bot STEPs (distance from the occt mesh, area
sampled, offscreen renders under the match's lighting):

- **One error bound for the robot, no sloppy pass** (`engine/simplify.ts`). The per-group share
  plus `simplifySloppy` fallback shredded every goBILDA group and 88 % of REV's (holes through
  perforated plates, gears as blobs): p90 2.09 mm, max 15.9 mm at 84k triangles. One absolute bound,
  found by a doubling ladder and five bisection steps, with `Prune`: p90 0.66 mm, max 3.6 mm at the
  same count. The bake's refit and `liteMesh` use it too, over the robot and its moving parts at once
  (`simplifyLists`).
- ⚠️ **One simplifier call per BODY, not per colour.** Touching bodies share positions but never
  vertices (`weld` keeps them apart); in one call the coincident vertices are seams, and a small body
  touching a big one reads as joined to it, so `Prune` cannot take it and the bound climbs until it
  takes everything. Measured at 250k triangles against the full CAD: the goBILDA kit (face-split
  read) went from p90 30.8 mm (63 % of the surface over 3 mm off) to 0.45 mm (none over 3 mm), and
  in ONE colour from p90 44 mm to the same 0.45; REV 0.19 → 0.17 mm; both twice as fast. Bodies under
  64 triangles share one call per part. Smoke: blocks standing on a plate.
- **At a shape cap of 0.2 % of the model's size, small bodies go before the bound climbs**
  (`dropSmallBodies`): smallest first, never one over 8 % of the size. A floor of fasteners no
  longer coarsens every other surface.
- **Detail** (Model step): **Full**, the default, keeps every triangle ("Full detail" below);
  **Light** reads at `LIGHT_TRI_BUDGET` (250k), for a slower computer. Maximum (400k) is gone: Full
  looks better and Light costs less. A new choice re-reads the dropped files, which the editor keeps
  in memory while it is open, with the setup as it is, the placements put back and the front as it
  was found (an assumed front stayed "Detected" after a re-read); after a reload, or for a saved robot
  (its stored mesh is what there is), it applies the next time a CAD file is read.
- **Finish by colour** (`robotImport/finish.ts`): light neutral → metal 1 / rough 0.4, mid neutral
  → 0.5 / 0.45, dark → 0 / 0.6, saturated → 0 / 0.45. Every part was 0.05 / 0.55, which turned
  anodised aluminium to chalk. A stored mesh with the old pair is upgraded on load. The editor
  preview has a room environment so a metal has something to reflect.
- **The robot receives shadows** in BIOBUZZ 3D (`prepareImportedMesh`); it read as a flat cut-out.
- **Light: 250k triangles, stored compressed** ("Budgets"). The float GLB held 69k of the REV kit in 4 MiB
  (the bake refit the 81k simplification down). Compressed, REV at 248k is 2.08 MiB and goBILDA's
  BIOBUZZ kit 2.41 MiB. At 250k REV is its CAD to p90 0.17 mm, max 0.74 mm (p90 0.56 mm at 100k);
  400k and 600k gain 0.07 and 0.12 mm more. Rendered offscreen under the match's lighting against
  the old stored meshes: the omni rollers, the hubs' hex pattern, the flywheel's gear teeth and the
  perforated plates come through, and nothing of the quantisation shows. goBILDA's mecanum rollers
  are still faceted at 250k.
- **Not worth it (measured):** finer STEP tessellation (0.25 rad: twice the triangles in, the same
  error out at 250k; at Full, below), another crease angle (40° holds), the 48-colour cap (the kits
  have 12 and 13).

### Full detail

Owner, 2026-10-04: "the CAD import quality looks horrible, even with the best settings. Can you just
import it 100%?" Rendered under the match's lighting, the 250k mesh against all of goBILDA's BIOBUZZ
kit: the intake rollers' perforations, the omni wheels' rollers, the tyre tread and the ramp plate's
grid of holes are gone or broken at 250k and there at Full.

- **What is kept.** `simplifyModel` at `FULL_DETAIL` keeps the reader's every triangle, welded (the
  weld drops degenerate ones: 3,015 of BIOBUZZ's 5.66M) and creased, as `PreparedModel.full`; the
  preview draws it, the bake stores it, BIOBUZZ 3D draws it, the 2D top picture is drawn from it. The
  editor measures, finds moving parts and picks on `parts`: a simplification to about
  `MEASURE_TRI_BUDGET` from the same weld (`keepFull`), so a body id names the same CAD body in both,
  that keeps EVERY body (`keepBodies`: no `Prune`, no small-body drop, and a body that collapses
  anyway comes back whole, 1,152 of BIOBUZZ's 3,930, median 0.7 mm across, 50k triangles). A body the
  measured copy lost could be neither picked nor found moving, and would stand still in the full mesh
  while its wheel turned. The saved footprint, height and wheels of all three kits are the same at
  Full and Light to the 1/64 in.
- **`normalise` hands the full mesh in the model frame** (`shownParts`) for the newest orientation
  only. The preview draws it and tests a click against the measured copy, never drawn (`pickModel`): a
  ray through 6M triangles would cost a hover tens of times what it does.
- **The bake's mesh half runs in the import worker** (`bakeModelHere`): the robot-local frame, the
  split into moving parts (`splitMoving`, typed arrays now: a JS array per attribute and a `Map` per
  vertex took seconds on the static rest) and the GLB. A share file is added through the import
  worker too, and `creasedNormals` writes typed arrays (the same arrays out).
- **Measured** (offscreen production build, `realcadprobe.cjs --gpu --details Full,Light`, a 32-thread,
  63 GB machine shared with other sessions, RTX 4070 Ti SUPER). Frame time is the page's work in each
  animation frame with a one-pixel `readPixels` after it, so the GPU's share is in it: BIOBUZZ 3D test
  drive, the robot driving, 1315 × 703 (Extreme 1972 × 1054), median of each 6 s pass, two passes per
  tier with Full and Light taking turns. Light is the mesh the build before stored as Standard: the
  same GLB byte for byte for BIOBUZZ and REV; goBILDA DECODE's has the same 249,142 triangles and one
  more roller group, found on the Full copy before the switch to Light kept it.

| kit | detail | triangles | import | stored | save | re-open | Low | Medium | High | Ultra | Extreme ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| goBILDA BIOBUZZ (420 MB) | Full | 5,656,143 | 68 s | 27.0 MB | 2.5 s | 7.4–8.3 s | 2.5–2.8 | 4.0–4.5 | 4.2–5.1 | 4.5–4.8 | 7.3–7.5 |
| | Light | 249,482 | 69 s | 2.44 MB | 0.4 s | 0.9 s | 2.3–2.4 | 2.8–3.8 | 3.6–3.7 | 3.5–4.4 | 5.4–5.8 |
| goBILDA DECODE (390 MB) | Full | 6,236,842 | 71 s | 31.8 MB | 3.2 s | 6.7–8.4 s | 2.7–2.8 | 4.1 | 4.3–5.0 | 4.4–5.7 | 7.3–7.8 |
| | Light | 249,142 | 75 s | 2.44 MB | 0.4 s | 0.9 s | 2.2–2.3 | 3.0–4.3 | 4.1–4.5 | 3.2–3.9 | 6.1–6.4 |
| REV DUO DECODE (125 MB) | Full | 2,311,122 | 41 s | 10.2 MB | 1.4 s | 3.1–4.8 s | 2.4–2.9 | 3.6 | 3.4–4.7 | 3.3–3.7 | 7.5–7.8 |
| | Light | 248,634 | 33 s | 2.08 MB | 0.4 s | 0.9 s | 2.4–2.5 | 3.2–3.7 | 3.1–5.0 | 3.5–4.0 | 6.1–8.1 |

  On this GPU Full costs 0–2 ms a frame more than Light, every p95 under 9 ms. The import's renderer
  peak is occt's either way (3.3–3.6 GB). In the test drive the renderer holds 1.1 (REV) to 2.3 GB
  at Full against about 0.6 GB at Light (the editor's draft stays in memory for the way back), the GPU
  process 0.55–0.84 GB. The editor's orbit holds 1.6–1.8 ms a frame (Light 1.0–1.4); the import's
  longest main-thread task 0.42–0.76 s (0.27–0.83 s before: the roller search), 1.3–2.5 s blocked in all.
  A draft restored after a reload takes 0.9–1.6 s.
- **Re-opening a Full robot re-makes the measured copy** from the stored mesh in the import worker
  (weld, ladder, creases): the ladder's first rung of a `keepBodies` copy starts at the largest power of
  two under half the reduction asked for (8× on these kits), which took BIOBUZZ's preparation from
  8.0 to 4.8 s in Node and its re-open in the editor from 8.3–10.2 to 7.4–8.3 s. Still several
  seconds against Light's one. Reading the stored normals instead of creasing again would save
  another 1.3 s; the readers keep positions only, so that is left.
- **Tessellation: 0.5 rad stays.** BIOBUZZ read at 0.25 rad is 12.8M triangles (2.27×). Rendered 3 in
  across under the match's lighting, only the omni wheels' doubly curved rollers change (less
  faceted); every plate, hole, gear and tyre is the same. Twice the stored size, memory and drawing
  for that.
- **Open:** a slower GPU. Here Full costs at most 2 ms a frame; on an integrated GPU, ten or more
  times slower, the same mesh could cost tens of ms at Medium and up, and only Light helps (no lighter
  copy is stored for the low tiers). The relay's lighter mesh from a Full robot takes ~6 s in the
  import worker the first time a room asks (cached after).

## Practice tuning

`ImportedRobot.tune` (`ImportTuning`, `docs/area/robot-import.md`; coerced by `coerceTune` to
`IMPORT_TUNE`'s ranges and steps) lets a player set the numbers the sim would otherwise derive:
top speed, acceleration, turn rate (`driveParams`), the fixed aim's turn rate (`fixedAimTurn`), time
between shots (DECODE turret and fixed, BIOBUZZ turret and fixed, Chain turret), flywheel spin-up,
intake time (DECODE, BIOBUZZ), dumper reload (BIOBUZZ, Chain), turret slew (BIOBUZZ, Chain) and the
BIOBUZZ ramp swing (`bbRampDeployS`, which every ramp reader asks). Turn rates are stored in °/s.
The editor keeps it in `ImportSetup.tune` and `buildSpec` puts it on the descriptor; the fields and
their calculated values are `ui/tuneFields.ts`.

- **Every read is `tune?.x !== undefined ? tune.x : <the old expression>`**, so a robot without
  tuning steps byte for byte as before (the import pins hold unchanged). A tuned interval that a
  `world.time >= fireReadyAt` test reads is scheduled `FLY_FEED_TIME_EPS` early, or it slips a tick.
- **Practice only.** `Room.beginMatch` strips it from every setup (`stripTune`), custom and LAN
  rooms included: the room is everyone's, and a client without tuning would predict the untuned
  robot. Ranked and records never see an import at all.
- **A replay with tuning is format 4** (`REPLAY_FORMAT_TUNED`), so a build before it calls it
  `future` instead of re-simulating the untuned robot. Untuned imports stay format 3.
- **A retune is the same robot** to the library (`sameImportedRobot` ignores `tune`) and does not
  re-bake the mesh (the bake stamp leaves it out).
- **Settings:** this build sends `caps: ['robotImport', 'importTune']`; a save from an import build
  without the second keeps the stored tuning when the robot is otherwise the same
  (`keepTuneFromOlderClient`).

## Relayed to a room (VISUALS RELAY)

The picture and mesh live on the owner's device, so a custom or LAN room relays them (`docs/area/netcode.md`, VISUALS RELAY has the wire, budgets and validation). What the importer owns:

- **What goes:** the top PNG (every viewer, 2D is the default) and the GLB (BIOBUZZ's 3D view only). Caps: PNG ≤ 256 KiB with a side ≤ 1024 px (the bake is 512), GLB ≤ 1 MiB.
- **`liteMesh`** (`engine/lite.ts`, reached through `loadImporterEngine()`) makes the 1 MiB mesh when the stored one (≤ 128 MiB, tens of MB at Full) is bigger. It does NOT go back through `normalise`/`bake`: a re-measure could re-detect the wheels or the origin and land the mesh a hair off the footprint the sim was told about. It reads the stored GLB, simplifies the same vertices with the importer's simplifier, re-creases the normals and writes it back in the SAME stored mesh frame, so a viewer places it with `STORED_MESH_TO_ROBOT` exactly as the full one. Measured against real GLTFExporter output: 140k triangles, 2.5 MB → 0.9 MB, bounding box unchanged to 0.1 mm, both colours kept. It returns null below 400 triangles, and the relay then sends the picture alone.
- **The relay never gets the compressed stored mesh.** `liteMesh` always writes a FLOAT GLB (`exportStoredScene`, `floatGlb.ts`): a compressed mesh goes through it however small, whole when the float copy fits 1 MiB, else aimed from the float copy's size. From the REV kit's 248k stored mesh it makes 19.8k triangles in 0.97 MB (the old 69k float mesh gave 16k). A mesh that cannot fit the cap by eight times (a Full robot) is aimed from the float writer's usual 46 bytes a triangle instead of writing all of it as float to find out: from goBILDA's BIOBUZZ kit at Full (5.66M, 27 MB) 18.9k triangles in 0.89 MB, 6.3 s in Node (9.1 s writing it whole first), made once and cached (`meshLite`). The owner sends the library's file as it is only when `validateMeshGlb` takes it, which is a float mesh saved before (`libraryOwnAssets.mesh`). So nothing on the wire changed and no server needs a deploy. An older client holding a compressed mesh (from a share file) refuses it at its own validator and sends the picture alone.
- **`meshLite`** is cached on the library record (`LibraryRobot.meshLite`, `meshLiteFor`, `putMeshLite`; the file key `<id>:meshLite`). `putRobot` drops it unless the save carries one, because the mesh it was cut from may have changed; `deleteRobot` removes it; `getRobot` returns it when present. It is never required.
- **A viewer sees what the owner's device would**: the relayed blobs are lent to the renderers' registry, which prefers a lent blob over the library, and are taken back when the room is left or the viewer turns "Show other players’ imported robots" off. A lent blob carries its LENDER (`registerImportedAssets(id, assets, lender)`): `''` is this device (the editor's draft) and always wins; `relay:<owner>` is a room's, and never replaces another lender's look for that id.
- **The relayed mesh must be what the float exporter writes and nothing more.** The relay's GLB check (`validateMeshGlb`) is an allowlist sized to `exportStoredScene`'s output: no glTF extensions, no images or textures, only POSITION/NORMAL/TANGENT/COLOR_0/TEXCOORD_0-1 and `_BODY` attributes, nodes with a mesh, children and a transform. The bake's own file (quantised, meshopt) is outside it on purpose. To relay that file directly, both extensions need field checks in `VISUAL_GLB_EXTENSIONS` AND a capability every receiver advertises, because older servers and clients run the old check; until then `liteMesh` stays in the path.
- **A host that draws frames in one burst must wait for them.** The pictures and meshes load
  lazily (a draw asks, a later task delivers), which a live view never notices and the replay
  export did: it draws every frame before the browser gets a turn, so a file made from a viewer
  that had not shown the import yet opened on its silhouette. The export awaits
  `importedTopsSettled` (2D) or the scene's `assetsSettled` (3D, `importedMeshesSettled`),
  raced against `IMPORT_ASSET_WAIT_MS`, before frame 0.
- **Robot ids are unique within a room.** A seat may not hold an id another seat holds (`IMPORT_ID_TAKEN`). An import of a SHARE FILE should therefore mint a new id (`duplicateRobot` does), or two teammates who loaded the same file cannot sit in one room until one duplicates it. The one exception is the account's own active robot arriving on a second device (next section): one player holds one seat.
- **The owner is told when its look does not reach the room** (`ImportVisualsClient.ownLookTrouble`, `ownLookLine`): a room refusal (out of space, a file it cannot use, an id taken, an upload it never confirmed), a model not on this device, or one out of date here. The custom-room lobby says it in ONE line in place of the robot's build line under "Your robot", so the section does not move; every line is ≤ 64 characters (smoke `visuals/owner`).
- **Only a look made for the robot the seat holds is sent.** The owner compares its library record's descriptor with the seat's (`OwnAssets.describe`) and sends nothing for an out-of-date copy; a VIEWER whose library holds an out-of-date copy of another seat's robot takes the relayed look instead of its own (`has(id, imp)`).
- **The relay client stays in `main`** (it was a candidate for a lazy chunk, lane 8, 2026-10-02 re-measured: 9.0 KB minified, 3.3 KB gzip of its own). Every call into it is synchronous and arrives on the socket's message path (`bind`, `release`, `onWelcome`, `noteRoster`, `handle` from `LobbyClient` and `ServerSession`, `setOffered`/`setGame` from the lobby) and the lobby reads `ownLookTrouble()` while rendering. A lazy chunk needs a stand-in that holds the transport, the offer, the game, the seat and the last roster, queues the frames that arrive while the chunk loads, and replays all of it in order: a SECOND state machine beside the real one, whose bind/release/reset ordering is exactly where this layer's bugs have been (a hand-off between the lobby and the match keeps the state, another transport clears it). About 2 KB of gzip in a ~1 MB entry chunk does not pay for that. Revisit only with a test that drives the stand-in through a lobby-to-match hand-off and a reconnect.

## The active robot across devices (`libraryIds.ts`)

The ACCOUNT syncs the active robot's SPEC (`settings.spec.imported`: id, hull, mechanisms) and never its model; the mesh and pictures live in each DEVICE's library under `ImportedRobot.id`. So device B receives device A's robot as a spec its library cannot answer for ("Model not on this device"), and B's fix is to import the share file A exported. The rule, all of it in `src/robotImport/libraryIds.ts` (types only, main-safe):

1. **A record answers for an id** when it has that id, or failing that, when it was added from a share file that carried it (`sharedFrom`): `libraryEntryFor`. Everything that turns `spec.imported.id` into a library record reads it: the robot page (`Menu.tsx`), the lobby's picker, the library actions (`useImportedActions` takes the list), and the library's own `topFor`/`meshFor`/`meshLiteFor`/`putMeshLite` (`answeringId`), which is what the renderers and the room relay ask.
2. **A share file whose robot IS the account's active robot keeps the active id** (`planShareAdd` → `adopt`). "Is" means the same descriptor whatever its id (`sameImportedRobot`), not the same file id: a teammate's copy of a file has its own id, and their second device must adopt THEIR id, which the file does not carry. The record's spec is the account's active spec (the file brings the model), so the add changes nothing that syncs. An older copy of it here under another id is retired.
3. **Any other share file gets a fresh id per device**, or the replace / keep-both question when this device already has the file's robot. Unchanged since 6035eca6.

4. **An EDIT saves under the active id when the record answers for it through `sharedFrom`** (`editSaveId`). A copy added from a share file before rule 2 has an id of its own; rule 1 offers it for editing, and saving it under its own id made the edit the active robot under a NEW id, which synced (the ping-pong again, reached by editing). The editor's Save writes it under the active id and deletes the old record.
5. **An OUT-OF-DATE copy is never drawn, sent or re-applied.** Edited on device A, the robot reaches device B as the same id with another descriptor, while B's record still holds the old model. The library says what a record holds (`descriptorFor`); the asset registry keeps the descriptor each picture and mesh came with and answers `null` to a reader that passes another version (`importedTopImage(id, imp)`, `importedTopUrl`, `importedMeshBlob(id, imp)`; the 3D mesh slot is keyed by the descriptor too), so the robot draws as its footprint; the relay's owner sends nothing for it (above). The robot page compares the record with the active robot (`sameImportedRobot`): the hero shows the footprint, ONE line at the top of the panel body (it arrives in the same render as the record's facts) says the model on this device is out of date and to import the robot's newest exported file, and the panel head's "Edit in the importer" becomes "Import the file" in the same place (an edit would save the old version over the new one). Picking the card that answers for the active robot (robot page, lobby) is a no-op, since applying the old record's spec would revert the account. Importing the newest file adopts it (rule 2) and replaces the record.

⚠️ **Never let an add, an edit or a pick on one device change the active id behind the player's back.** Before this rule a share-file add always minted an id and made it active; the new id synced, A's own robot became "not on this device", re-importing on A moved it back, and the id ping-ponged between the devices. Smoke plays the two devices out (`imports/library ids`, and `stale copy:` for rule 5).

⚠️ **AN OLDER CLIENT'S SETTINGS SAVE NO LONGER STRIPS THE IMPORT** (`src/net/settingsKeep.ts`, `docs/area/accounts.md` "Settings sync"). main, and alpha until this branch merges, rebuild the spec field by field in `coerceSettings`, and `/api/user/settings` stored what it was sent, so any save there dropped `spec.imported`, `lastStandardSpec` and imported loadouts. This build sends `caps: ['robotImport']` with the save; a save without it is merged per game with the stored blob: the stored imported robot is kept when the incoming one is it minus what the older build cannot read (every field it sent equal), with its last standard robot; any change made there stands. Measured with the real main and alpha coercers (all three games, archived loadouts, a game switch on the older build). ⚠️ One robot an older build CHANGES rather than strips: a BIOBUZZ fixed launcher reads as a turret there (and its mass moves), so that save is a real change and the import is not re-attached.

**The library is not created by looking.** `indexedDB.open` makes a database that is not there, and the renderers ask the library the first time any imported robot is drawn, so a viewer in a custom room who never imported anything got an empty `decodesim.robots`. Every READ (`listRobots`, `getRobot`, `topFor`/`meshFor`/`thumbFor`/`meshLiteFor`, `descriptorFor`, the drafts) first asks whether it exists (`indexedDB.databases()`, else an unversioned open whose upgrade from version 0 is aborted) and answers "nothing here" when it does not; only a write creates it. Smoke `library:` drives both ways of asking against a stub.

## The importer UI (`src/robotImport/ui/`)

Route `/<game>/configure/robot/import[/<id>]` (`App.tsx` matches it BEFORE the configure section
pattern, or `import` reads as a section name). Four steps: Model, Drivetrain, Mechanisms, Review.

**Two halves, two chunks.** The robot page is in `main`; the editor is lazy.

| main (the robot page, the lobby, Modes) | lazy (`ImportEditor-*.js`, route `importerui`) |
|---|---|
| `pageCopy.ts` (row, panel, dialog strings), `handoff.ts` (files handed to the editor, the one-shot notice, the `dsim-robot-library` BroadcastChannel), `useLibrary.ts`, `ImportedRobots.tsx` (row, panel, actions) | `ImportEditor.tsx` and the five steps, `copy.ts` (every editor string), `editorModel.ts`, `placement.ts`, `draftStore.ts`, `TopDownMap.tsx`, `PreviewPane.tsx`, `useHandleGrab.ts`, `src/ui/importer.css` |
| reached by `import()` on a click: `LibraryDialogs.tsx`, `exportRobot.ts`, `shareFile.ts` | |

- ⚠️ **A main-side file must not import `geometry.ts` or `ui/copy.ts`.** Rollup puts a module
  imported by `main` wholly in `main`, so one static import moved the measurement code (8 KB)
  and the editor's strings into every page load. The robot page uses `polyBounds` from
  `src/sim/imported.ts` and `pageCopy.ts`. A smoke check greps for it.
- ⚠️ **Three more things stay OUT of `main`, and each was in it once** (`npm run bundleaudit` is
  what noticed). (1) `library.ts` (IndexedDB) is reached only by `import()`: the renderers' asset
  seam and the visuals relay's client both do it that way, and its `library` route reading
  `absent` means someone imported it statically. (2) The relay's PNG/GLB validators are
  `src/net/visualCheck.ts`, imported statically by the server (and so by the LAN host worker) and
  by `import()` from the client, which needs them only when a look is uploaded or received; put
  them back into `importVisuals.ts`, which `api.ts` and `protocol.ts` import for a capability
  string, and ~12 KB of minified code is in every page load. (3) The per-game placement checks
  (`<game>/importChecks.ts`) are reached only through `src/games/importMechChecks.ts`, which only
  `placement.ts` (this editor) imports; they are not on `GameSimModule`.
- **The editor works in the MODEL frame** (wheels, handles, the map); `ImportedMech` is stored
  ROBOT-local. `placement.ts` converts (`mechRobotToModel`, and `mechModelToRobot` in
  `geometry.ts` on the way out) and wraps lane 2's `mechHandles` / `defaultImportedMech` /
  `validateImportedMech` (all three from `src/games/importMechChecks.ts`). The mount pickers (`intakeMount` …) still decide WHICH edges exist;
  the map only places them. A player's placement is never moved by a later default.
- **Wheels: two layouts** (`ImportSetup.wheelLayout`, `editorModel.ts`). RECTANGLE: the four
  wheels sit on four lines (front and back axle, left and right side); a drag, a key, the pad or
  a field moves the two lines through a wheel, so the four are always an exact rectangle, and the
  lines stay 1 in apart. Its fields are Wheelbase, Track width, Centre forward and Centre left
  (the wheels' centre from the footprint box centre), step 1/16 in; each sets exactly what was
  typed (`setRectNumber`), size about the centre, centre with the size kept. FREE: one wheel at a
  time, with its Forward and Left. A POINTER drag snaps onto a floor contact within 0.4 in, else
  to the 1/16-in grid; keys stay 1/4 in and Shift 1/16 in. The old Mirror toggle is gone: the
  Track width field changes the track about the wheels' own centre line.
- **Lining up detected wheels** is the measurement's (`finishMeasure`), so every path (a units
  change, Use detected wheels, a re-open) agrees: in `rect` any detected four become the
  rectangle of their averaged lines; with no layout picked yet, only when each line's two wheels
  are within 0.75 in (`WHEEL_SQUARE_TOL_IN`), and the note and the Wheels fact say so; `free`
  never. Squaring an exact rectangle is the identity, so a robot detected square measures bit for
  bit as before. Placed wheels are never moved by it.
- **The layout persists with the setup**; absent (setups from before it, a new file) it is read by
  `wheelLayoutOf`: a rectangle when the wheels are one (placed ones exactly, detected ones within
  the tolerance), else free, so nothing placed by hand moves. A wheel placed writes the layout it
  was placed in. Picking Rectangle lines placed wheels up on their averaged lines; picking Free
  moves nothing placed (detected wheels then show as found). The measurer's light-half cache is
  keyed by the layout too.
- **`NumberField` commits only an edited value.** It shows the value rounded to its step and
  snapped that on every blur, so a Tab through a wheel field moved the wheel.
- **Re-opening a saved robot re-reads its STORED mesh**, not the source file (the library does
  not keep it), so the setup is units `m`, up `+y`, quarter turns 0, and the placements are the
  saved ones converted back to the model frame.
- **Drafts.** `decodesim.robots` v2 adds `drafts` and `draftModels`. Key
  `<game>:<editId | new>`. The document is written 800 ms after the last edit; the parsed model
  once. A draft is deleted on save, on Discard, and with its robot; `listDrafts` prunes any older
  than `DRAFT_MAX_AGE_MS` (30 days). The robot page's add card turns into Resume import while
  one exists.
- ⚠️ **Review blocks what `coerceImported` would refuse.** A spec whose import `coerceImported`
  drops (a side under `IMPORT_MIN_SIDE`, an area under `IMPORT_MIN_AREA`, a sliver) saves fine
  and then plays as its parametric fallback with no word said. `reviewItems` blocks whenever the
  built spec has no `imported`, so a new refusal there is covered without a new item.
- ⚠️ **`computeBands` gives up above 1.5 × the 18 in cube** (`BAND_MAX_HEIGHT_IN`). Its cost
  grows with the cube of the slice count; a model in the wrong units (381 in tall) took 42 s
  and froze the editor between two clicks on Units. A robot that tall is refused anyway.
- **Test drive** passes the draft's spec to `GameView` (`testDrive`), frozen at mount: free
  drive, its own assists, the default start, no other robots, no Zenith auto. Leaving the
  match returns to the editor route, and the draft is flushed first, so nothing is lost.
- **The preview takes a fresh `<canvas>` per controller.** Re-using one after `dispose()`
  (which forces a context loss) threw `Cannot read properties of null (reading 'precision')`
  on the next mount. A lost context falls back to the top-down map.
- **The pictures come from the engine**: `bake` on save, and for a shared `.dsim.glb` added as it is,
  `renderTop` / `renderThumb` on its parts moved by `STORED_MESH_TO_ROBOT`. Never a UI-side render.

## Proving it

- `npm test` runs the DOM-free half (a block at the end of `scripts/smoke.ts`): the catalogue,
  hull/reduction/wheels/bands, units and up axis in every orientation, HANDEDNESS (the synthetic
  robot carries a flag on its left side only), the descriptor's contract shape, the frame
  matrices, and the share file's byte layout. The `robot import (scale)` block after it holds the
  worker moves to the old outputs bit for bit, and the simplified measurement to its tolerance.
- `scripts/robot-import/harness/` is a throwaway Vite page (`npx vite scripts/robot-import/harness
  --port 5191`) that runs every fixture format through the real engine in a browser, re-imports
  each baked GLB to check the stored frame round-trips, and writes the outputs to
  `$ROBOT_IMPORT_OUT`. Fixtures (`scripts/fixtures/robot-import/`) are regenerated by
  `npm run robot-import:fixtures`; each format uses a different unit and up axis on purpose.
- The UI's DOM-free half is the `import UI …` checks in the same smoke block: the copy rules,
  the review list per game (an ordinary robot passes, a 0.5 in one blocks), the draft key, the
  wheel layouts (`import UI wheels:` drags, typed numbers, snapping, lining up, old setups), and
  source pins on the test drive, the route order and the pad rail.
- `scripts/importshots.cjs` photographs every editor state at 1440×900, 1100×720 and 390×844 in
  both themes, in an OFFSCREEN Electron window, into `scratch/importshots/<sha>/` with an
  `index.html` sheet. `scripts/importpad.cjs` walks the editor by stubbed gamepad and then by
  real key events and asserts each step. Both need `npx vite --port 5194 --strictPort` running
  and `env -u ELECTRON_RUN_AS_NODE npx electron scripts/<file>`.
- `scripts/importprobe.cjs` measures the UI's cost against a PRODUCTION build (`npx vite preview
  --port 4173`), cold cache, long tasks observed from before the first script. Measured
  2026-10-01 (desktop, software GL): six imports add no long task to the robot page; the empty
  editor fetches its chunk and `geometry-*.js` (the measurement code it runs) but not the engine;
  the 18 KB GLB fixture reaches its first frame in ~200 ms with no long task; 150k triangles:
  first frame 524 ms, longest task 142 ms (budget 200); re-opening a saved import 147 ms the
  first time, 24 ms warm; ten editor trips: heap flat after GC, no "Too many active WebGL
  contexts".
  Past ~250k triangles the longest task broke 200 ms (368k gave 307 ms, nearly all `simplifyModel`);
  that is what moved into the import worker (see "Workers").
- **At real-CAD scale**: `npx tsx scripts/robot-import/stress.ts` writes the stress robots (0.5, 1.5
  and 3.9 M triangles as shared-mesh GLB, flat GLB and binary STL, and an analytic STEP) to
  `%TEMP%/dsim-robot-stress` (30–190 MB each, never committed). `scripts/robot-import/stressprobe.cjs`
  drives the real editor with them against a production build (import timeline, long tasks, renderer
  memory, each Model-step edit, a preview zoom, Save, Cancel with the CPU after it), and
  `scripts/robot-import/stressbench.ts` times the engine's stages in Node and, with `--full`, the
  accuracy of measuring the simplified mesh against the full one.
- **Real CAD**: the `robot import (real CAD)` smoke block holds what the vendors' starter bots showed
  (see "Real CAD" above): pieces read to the whole read's triangles, complete pieces, the part sizes,
  cut-off and non-STEP files, zips (deflated and stored, a model with its companions, none at all),
  the 3MF small DOM against Chromium's DOMParser (hashes measured in `harness/main.ts`, which parses
  the fixture and `threeMfSample.ts` with both), the glTF merge as it reads and the consumed
  simplification against the old outputs bit for bit, the front in 24 orientations, and the editor's
  Assumed note. The `robot import (STEP colours)` block places the fixture's 10-body part twice in an
  assembly (occt reads it all grey) and holds the hint to occt's own colours, whole, in pieces, split
  into faces and cut by the size filter. `scripts/robot-import/realcadprobe.cjs --files <paths> --out <dir>` imports real
  files through the production editor in an offscreen Electron window, one at a time (timeline,
  long tasks, renderer and total memory, what the Model step says, pictures, Save and the saved
  descriptor, the stored mesh, a test drive). It needs a STEP or zip on disk: the vendors' files are
  never committed.
