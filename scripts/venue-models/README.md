# Modeled venues (BIOBUZZ 3D)

One CC BY 4.0 glTF from Sketchfab in, one `public/venues/<id>.glb` out. Rules: `docs/area/biobuzz.md`,
MODELED VENUES. Runtime: `src/games/biobuzz/scene/renderModelVenue.ts`.

## Before a build

- **The source**: the owner downloads it (Sketchfab needs a login), glTF format, into
  `D:\Projects\dsim\venue-sources\<uid>\` (zip or extracted). Raw files never go in git; the folder is
  in `.git/info/exclude`.
- **The tools**, outside the repo like the field pipeline's: in `%LOCALAPPDATA%\dsim\venue-models\npmtools`,
  `npm install @gltf-transform/core@4.5.1 @gltf-transform/functions@4.5.1 @gltf-transform/extensions@4.5.1 meshoptimizer@1.1.1 sharp ktx2-encoder@0.6.0`.
  `ktx2-encoder` is Basis Universal compiled to wasm, so no `ktx`/`toktx` binary is needed.

## Steps

1. `npx tsx scripts/venue-models/build.ts <id> --inspect` lists the meshes (largest first, `--all` for
   every one, with their materials and bounds in the source's own units, z up), the textures and the
   extensions.
2. In `venues.ts`, set `scale` (metres per source unit: a SketchUp export is often left in inches,
   0.0254; a stylised model is scaled until something with a known size is right, like a 10-ft rim),
   `fieldAt` (a clear stretch of floor, x and y, source units), `floor` (its height: probe the real
   surface rather than trusting the inspect bounds, which can be a few cm off), `yawDeg`, and `drop`
   or `dropMaterials` for anything that must go. A SketchUp export names every node after a material
   and merges each material's faces into one mesh, so there a part is only addressable by material.
   Read the model's page: another author's work placed inside it (the hangar's DA42) is credited with
   `includes`.
3. `npx tsx scripts/venue-models/build.ts <id>` writes the GLB and prints the row's numbers. It fails,
   naming the meshes in the way, if the field's footprint and the eyes round it (`EYES`: every driver
   eye, the chase eye, the menu's home eye, plus the margin) are not clear.
4. Check the size over the wire, which is what a player waits for: Vercel serves `.glb` with brotli,
   which takes geometry down several times and KTX2 textures by only a few percent. Where textures
   dominate, `maxTexture`, `maxNormal` and `textureCaps` trade resolution where it is not seen
   (a tiled material, props in the dark) for megabytes.
5. Add the row to `BB_ENVIRONMENTS` with `model: { file, bytes, tris, cameraRoom, title, page,
   authors, license: 'CC BY 4.0', licenseUrl: CC_BY_4 }`, a painted `look` and `rig` for its light, and
   a procedural `venue` that stands on Low/Medium. Add the id to `EnvironmentId`, `ENVIRONMENT_IDS`
   and `VENUE_FLOOR_FINISH`.
6. `npm test`: the RENDER lane parses the file, checks its bytes, and sweeps every in-match eye
   against its `cameraRoom`. Capture it from every camera before shipping.

`--placeholder` runs every step on a generated room into `scratch/venue-models/` (no download needed).

## A generated venue (`grb`)

A source row with a `generator` is built by a script in this folder instead of a download:
`npx tsx scripts/venue-models/build.ts grb` runs `grb/generate.ts` (numbers in `grb/layout.ts`, pit cells
in `grb/pits.ts`, textures in `grb/textures.ts`, geometry kit in `grb/mesh.ts`), writes the uncompressed
source to the tools' work folder (`--source` stops there), then builds it like any other. The generator
states a `keepClear` box (the sim's eyes plus the margin); the build fails if its clear box does not
contain it. Research, sources and every estimate: `docs/venues/grb.md`.

## What the build does and why

- **z up, inches, the field at the origin.** The scene is z up in inches; glTF is y up in metres.
  One `venue` node carries the turn, the scale and the placement; the field's floor goes to the
  procedural ground's height (−0.75 in), under the mat, so nothing z-fights.
- **Lights, cameras and animations are removed.** The row's `rig` lights the room, like every other
  venue.
- **The clear box** (`src/games/biobuzz/graphics/venueRoom.ts`): grown from the field's footprint and
  `EYES` until a triangle above the floor would enter it, the ceiling first (the growth is greedy:
  walls first ran a gym's box out to its hoops, and the rims then capped its ceiling under the menu
  eye). Its inset is the row's `cameraRoom`. A box is convex, so no sight line from an eye inside it
  to the field can be blocked; the orbit and free eyes are held in it, and the top-down cameras' near
  planes cut at its ceiling.
- **Textures**: resized to `maxTexture` (`maxNormal`, `textureCaps`), then KTX2. Normal maps UASTC
  with RDO, so zstd can shrink them; colour slots ETC1S in sRGB; the rest ETC1S linear. Geometry:
  meshopt (`EXT_meshopt_compression`, quantized).
- **No decimation by rule.** Keep full detail where frame time and download allow; a simplified copy
  only for a tier that measurably needs it.
- **Instancing**: after the clear box, every mesh placed twice or more becomes one
  `EXT_mesh_gpu_instancing` draw (three builds an `InstancedMesh`).
