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

1. `npx tsx scripts/venue-models/build.ts <id> --inspect` lists the meshes (largest first, with
   bounds in z-up metres), the textures and the extensions.
2. In `venues.ts`, set `fieldAt` (a clear stretch of floor, x and y, metres), `floor` (its height),
   `yawDeg` (field x along the room's long axis), and `drop` for anything that must go (another
   author's model, a prop on the field's floor).
3. `npx tsx scripts/venue-models/build.ts <id>` writes the GLB and prints the row's numbers. It fails,
   naming the meshes in the way, if the field's footprint and a driver's reach round it are not clear.
4. Add the row to `BB_ENVIRONMENTS` with `model: { file, bytes, tris, cameraRoom, title, page,
   authors, license: 'CC BY 4.0', licenseUrl: CC_BY_4 }`, a painted `look` and `rig` for its light, and
   a procedural `venue` that stands on Low/Medium. Add the id to `EnvironmentId`, `ENVIRONMENT_IDS`
   and `VENUE_FLOOR_FINISH`.
5. `npm test`: the RENDER lane parses the file, checks its bytes, and sweeps every in-match eye
   against its `cameraRoom`. Capture it from every camera before shipping.

`--placeholder` runs every step on a generated room into `scratch/venue-models/` (no download needed).

## What the build does and why

- **z up, inches, the field at the origin.** The scene is z up in inches; glTF is y up in metres.
  One `venue` node carries the turn, the scale and the placement; the field's floor goes to the
  procedural ground's height (−0.75 in), under the mat, so nothing z-fights.
- **Lights, cameras and animations are removed.** The row's `rig` lights the room, like every other
  venue.
- **The clear box** (`src/games/biobuzz/graphics/venueRoom.ts`): grown from the field's footprint until
  a triangle above the floor would enter it. Its inset is the row's `cameraRoom`. A box is convex,
  so no sight line from an eye inside it to the field can be blocked; the orbit and free eyes are
  held in it, and the top-down cameras' near planes cut at its ceiling.
- **Textures**: resized to `maxTexture`, then KTX2. Normal maps UASTC; colour slots ETC1S in sRGB;
  the rest ETC1S linear. Geometry: meshopt (`EXT_meshopt_compression`, quantized).
- **No decimation by rule.** Keep full detail where frame time and download allow; a simplified copy
  only for a tier that measurably needs it.
