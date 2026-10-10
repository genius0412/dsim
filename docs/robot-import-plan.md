# Robot import — plan and contract (branch `feat/robot-import`)

A player imports their own robot from CAD and drives it in DSIM with its real footprint, size,
mass, gearing and mechanism positions. Imported robots play in **solo practice, free drive, custom
rooms and LAN rooms only**. Ranked, ranked challenges and record runs refuse them on the server.

This file is the contract every lane builds against. Sections 3 and 4 are binding; change them
here first, then in code.

## 1. What the player gets

- **Import from a file** in Configure ▸ Robot: GLB/glTF, STEP, STL, OBJ, 3MF, PLY. STEP is
  parsed by a lazily fetched wasm (`occt-import-js`, LGPL-2.1, credited on the Contributors page)
  that is downloaded only when a STEP file is dropped.
- **Automatic setup, reviewable.** Units, up axis, floor, centre and front are detected; the
  footprint (convex hull of the robot seen from above), height, wheel contact points and the
  wheelbase centre are measured. Each detection is shown and can be corrected with one control
  (units picker, "rotate front 90°", drag a wheel). A typical robot needs no correction.
- **Real drivetrain numbers.** Drivetrain type, motor (FTC catalogue: goBILDA 5203 ratios, REV HD
  Hex + UltraPlanetary stack, REV Core Hex, NeveRest Orbital, custom free rpm), external ratio,
  wheel diameter, measured weight. The sim's own top speed, acceleration and push are shown
  beside them, read from `driveParams`, so what is displayed is what is driven.
- **Mechanisms from the game's builder**, then placed on the CAD: the same archetype controls a
  standard robot uses (launcher kind, intake kind, Box Tube, sorter …), plus a top-down editor
  where the player drags the intake mouth span along the hull edge and the launcher/placer point,
  and sets the release height.
- **Plain-language checks** before save: over 18 in in any direction (with a units hint when the
  number looks like mm or m), no floor contact, wheels off the footprint, too few wheels found,
  mass below the sim's floor for this build, rpm outside the sim's range (clamped, said so).
- **Test drive** from the editor (free drive with the robot, back to the editor on exit).
- **Library** of imported robots per game on this device (IndexedDB): rename, duplicate, delete,
  re-open in the editor, **export as one `.glb` file** that a glTF viewer opens (one that reads
  `EXT_meshopt_compression` and `KHR_mesh_quantization`, since 2026-10-03) and that carries
  the DSIM setup in `asset.extras.dsim`; importing that file restores the robot with no wizard.
- **In a match**: the owner sees their mesh (3D) or a top-down render of it (2D). Other players
  in a custom room see an extrusion of the footprint (3D) or its silhouette (2D) until the room's
  visuals relay delivers the picture (and, in BIOBUZZ's 3D view, a mesh of at most 1 MiB); a viewer
  can turn that off and keep the outline.

Lessons taken from existing robot-sim builders (surveyed 2026-10-01, notes kept outside the
repo): treat the mesh as skin and build physics from simple primitives; automate units /
orientation / centring instead of asking; derive drive feel from motor, ratio, wheel and mass and
show the computed numbers; validate in the UI in plain language, not in a log; test drive inside
the editor; share one small versioned file; keep custom robots out of ranked, enforced server-side.

## 2. Flow and screens

Configure ▸ Robot gains an **Imported robots** row beside saved robots: one card per library
robot (96px thumbnail, name, `buildWords`, an "Imported" tag), and an **Import a robot** card
that opens the editor. Selecting a card makes it the active robot exactly like a saved robot.

The editor is one screen with a step rail (Model · Drivetrain · Mechanisms · Review) and a
persistent preview (3D orbit view of the normalised model on a field tile, with the 18-in cube
and the measured hull drawn on the floor). Any step can be revisited; Review lists the checks and
holds Save and Test drive.

1. **Model**: drop zone / file picker → parse progress → auto-normalised preview. Shows L × W × H
   with pass/fail against 18 in, triangle count before/after simplification, detected units and
   up axis (each a small picker), front arrow with rotate buttons, the footprint hull and the
   wheel markers in a top-down inset (wheels draggable).
2. **Drivetrain**: type, motor, ratio, wheel, weight → computed equivalent wheel rpm, top speed,
   acceleration, push (sim truth). Warnings inline.
3. **Mechanisms**: the game's `Builder` mechanism controls with the frame controls hidden
   (size, drivetrain and mass come from steps 1–2), then the top-down placement editor.
4. **Review**: name, team, checks, Test drive, Save. Save adds to the library and makes the robot
   active.

Ranked and record entry points: when the active robot is imported, the robot row says
"Ranked uses a standard robot." and the swap picker offers standard robots only, preselecting
the last standard one used in this game.

## 3. Data model (binding)

### 3.1 The sim descriptor — `RobotSpec.imported?: ImportedRobot` (in `src/types.ts`)

Robot-local inches, **+x forward, +y left**, origin at the **wheelbase centre** (the centre of the
four wheel contact points; the hull's AABB centre when wheels are not known). Small (≤ 2 KB JSON),
plain numbers, no free text, so it rides `join`/`update`/roster/`matchStart`/replay setups
unchanged.

```ts
export interface ImportedRobot {
  v: 1;
  /** library id, 16 lowercase hex chars: names the mesh on the owner's device and in a room's
   *  mesh relay. Never read by the sim. */
  id: string;
  /** whole-robot footprint seen from above, starting configuration: convex, CCW, 3..16 vertices,
   *  quantised to 1/64 in, AABB ≤ 18 × 18 in. Robot-robot collision, field contact, start
   *  legality and zone fouls all use this polygon. */
  hull: Vec2[];
  /** top of the model above the floor, inches, (0, 18]. */
  heightIn: number;
  /** wheel contact points FL, FR, BL, BR, each inside the hull. Absent = the rectangle default. */
  wheels?: Vec2[];
  /** 3D only (BIOBUZZ): up to 5 stacked convex prisms for the tall parts (3 until 2026-10-04),
   *  z0 < z1 within [0, heightIn], each hull ≤ 12 vertices, each with at most 8 `cuts` (where the
   *  hull stands proud of the model, `ImportedCut` in `src/types.ts`). Absent = one prism of
   *  `hull` to `heightIn`. */
  bands?: { z0: number; z1: number; hull: Vec2[]; cuts?: ImportedCut[] }[];
  /** mechanism placements; each game reads the fields it knows. */
  mech?: ImportedMech;
}

export interface ImportedMech {
  /** a turret's axis, or a turretless launcher's lip centre; z = release height at rest pitch */
  shooter?: { x: number; y: number; z: number };
  /** a turretless launcher's facing, degrees CCW from forward, whole, (−180, 180]; only beside
   *  `shooter`. DECODE's fixed launcher fires along it (absent = forward); BIOBUZZ's fixed kind
   *  reads it when present, else its mount edge. */
  shooterYawDeg?: number;
  /** BIOBUZZ double turret: the NECTAR head */
  shooter2?: { x: number; y: number; z: number };
  /** span along an edge (y across front/back, x along left/right); one per edge, ordered
   *  front, back, left, right, at most 4 */
  intakes?: { edge: 'front' | 'back' | 'left' | 'right'; from: number; to: number }[];
  /** the placer's BASE (Box Tube, catalyst); it reaches out of the hull along its mount */
  place?: { x: number; y: number; z: number };
}
```

`mech` holds POSITIONS. Which edge an intake rides and which way a placer reaches stay the game's
own mount fields (`intakeMount`, `shooterMount`, `bbMech.lift.mount`, `catalystMount`); a span on
an edge the mount does not use is ignored, and DECODE reads the front edge only. Game ranges (a
DECODE launch height of at least 10.5 in, a mouth no wider than the hull at its face) are applied
where the sim READS them and reported by `validateImportedMech`, never written back.

An imported spec ALSO carries ordinary parametric fields so any reader that knows nothing about
imports sees a legal rectangle robot: `length`/`width` = the hull's AABB (clamped as today),
`massLb`, `drivetrain`, `driveRpm` (the equivalent rpm), and the game's mechanism fields
(`bbMech`, `intake`, `canSort`, `scoreMode` …).

Coercion (`coerceImported` in `src/sim/imported.ts`, called from `coerceSpec` with an explicit
carry-across for every game): recompute the convex hull from the given points (deterministic
monotone chain), drop non-finite input, quantise to 1/64 in, cap vertex counts, scale uniformly
about the origin if the AABB exceeds 18 in, validate `id` against `/^[0-9a-f]{16}$/`, clamp
wheels/bands into range. Mech, game-blind: every point's x/y moved to the nearest point inside
the hull, z clamped to `[0, heightIn]`; intakes need a known edge, `from < to` (swapped), clamped
to the AABB's range on that axis, at least 1 in wide, one per edge (first wins), ordered front,
back, left, right. Anything unrecoverable returns `undefined` (the robot plays as its
parametric fallback). **Idempotent**: `coerce(coerce(x))` deep-equals `coerce(x)`.

### 3.2 The library record (device only, IndexedDB `decodesim.robots`, registered in `storageKeys.ts`)

The database is named `decodesim.robots` (`ROBOT_LIBRARY_DB`), not `dsim-robots`: the storage
registry's checks require the `decodesim.` prefix and forbid that literal anywhere else, which is
what keeps the privacy page's table complete. `mesh` is in the stored-mesh frame and `top` in the
top-image frame, both defined in `docs/area/robot-import.md`.

```ts
interface LibraryRobot {
  id: string;            // = spec.imported.id
  game: GameId;
  spec: RobotSpec;       // the full spec, imported descriptor included
  mesh: Blob;            // simplified, normalised GLB (≤ 4 MiB, ≤ 400k triangles; quantised + meshopt since 2026-10-03)
  top: Blob;             // top-down orthographic PNG, 512 px, transparent, robot-local frame
  thumb: Blob;           // 3/4 view PNG for cards, 192 px
  source: { name: string; format: string; bytes: number; trisIn: number; trisOut: number };
  setup: ImportSetup;    // everything needed to re-open the editor: units, up axis, yaw, wheel
                         // overrides, motor/ratio/wheel choice, hull options
  created: number; updated: number;
}
```

`GameSettings.spec` may hold an imported spec (the descriptor is small; it syncs with the
account). `savedRobots` does not hold imports; the library does. On a device without the mesh,
the robot draws as its footprint (§1).

### 3.3 The share file

A `.glb` whose JSON chunk carries `asset.extras.dsim = { format: 'dsim-robot', v: 1, game,
spec, setup, name }`. Parsing the extras needs no three.js (read the GLB header and JSON chunk).

## 4. Rules every lane keeps (binding)

- **Standard robots are byte-identical.** Every new branch in the sim runs only when
  `spec.imported` is present. `npm test` must show identical results for existing scenes, and a
  check pins `worldHash` for a scripted standard-robot run before and after.
- **No `SIM_VERSION` / `BALANCE_VERSION` bump** (owner rule). No change to `driveParams`,
  `pushForce`, `motorStep` or the drivetrain limits for existing specs.
- **Determinism:** `src/sim/imported.ts` and every sim branch use `dsin/dcos/datan2`, no
  `Math.random`, no clock.
- **three.js stays lazy.** It may be imported only under `src/games/biobuzz/scene/` and the new
  importer zone `src/robotImport/engine/`, each reached only by a dynamic `import()`. The RENDER
  lane's guard is widened to name both zones, and `bundleaudit` gets an `importer` route (and a
  `step` route for the occt wasm).
- **Server:** `imported` is accepted only in custom and LAN rooms, behind a `'robotImport'` cap in
  both `CLIENT_CAPS` and `SERVER_CAPS`; refused at the ranked queue door, in staged/record rooms,
  stripped in `beginMatch` outside custom rooms, refused in `submitRecord`. A replay containing
  an imported robot is stamped `REPLAY_FORMAT` 3 (older builds refuse it rather than replay a
  box). Practice runs with an imported robot stay on the device (no `/api/practice` upload).
  `hostWorker.seat()` runs `sanitizePlayer` like the cloud path does.
- UI copy follows `docs/area/ui.md` (sentence case, `Couldn’t …` + a next step, typographic
  punctuation, no padding). CSS follows `docs/ui-standard.md`; look classes up in
  `docs/ui-components.md` before adding one. `uiaudit`, `uiindex`, `docaudit`, `contrast` pass.
- No competitor product names anywhere in the repo. No git stash/checkout/reset/clean.
  Electron captures run offscreen (`show:false`, `offscreen:true`).

## 5. Lanes (all merged on `feat/robot-import` by 2026-10-02)

Built as planned, plus three lanes the plan did not have: 6b (renderers read the sim's mechanism
accessors, nothing else), 8 (main-chunk trim and the bundle baselines) and 9 (workers, so a
multi-million-triangle CAD file never blocks the page), and a server-side review whose five fixes
are merged (bounded coercion cost, a GLB allowlist, one import id per room, rolling relay budgets,
caps re-read on rejoin). How it works now is in `docs/area/robot-import.md`; this table is history.

| lane | owner | files | after |
|---|---|---|---|
| 1 sim core | opus | `src/types.ts`, `src/sim/imported.ts`, `src/sim/{spawn,field,physics,physicsEngine,world,robot}.ts` geometry branches, `scripts/smoke.ts` | now |
| 2 mechanisms | opus | `src/games/{decode,chain,biobuzz}/**` sim side, `src/sim/{artifactSolids,goal,penalties,robot}.ts` mechanism bits, BIOBUZZ `sim3d` compound | analysis now, code after 1 |
| 3 importer engine | opus | `src/robotImport/{engine/**,library.ts,drive.ts,shareFile.ts}` | now |
| 4 importer UI | opus | `src/robotImport/ui/**`, `src/ui/Menu.tsx` hook-up, CSS | after 3 |
| 5 wire + server | sonnet | `src/net/**`, `server/**`, `src/sim/replay.ts`, `src/lan/hostWorker.ts`, ranked/record UI gating | after 1 |
| 6 rendering | opus | `src/render/**` imported sprite, per-game sprite hooks, `src/games/biobuzz/scene/renderImported.ts` | after 1 + 3 |
| 7 mesh relay | sonnet | custom-room mesh relay (chunked, capped, memory-only) | after 5 |

Gates per lane: `npm run build`, `npm test`, `npm run server:check`; plus `uiaudit`/`uiindex`
(UI), `bundleaudit` (chunks), `test:mm` (matchmaker), `dbtest` (repo/migrations), `docaudit`.
