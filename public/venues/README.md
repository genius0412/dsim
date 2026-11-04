# Venue models (BIOBUZZ 3D)

Processed, compressed venue files only, built by `scripts/venue-models/build.ts` (see its README).
Raw downloads stay outside the repo, in `D:\Projects\dsim\venue-sources\<source id>\`.

No photograph is projected onto geometry here. The photographed venues that lived in this folder
from 2026-10-10 (Poly Haven panoramas projected onto an approximate room) were removed on
2026-11-04: a projection is right only from its own lens, and every in-match camera warped it.

`vercel.json` serves `/venues` immutable for a year, so a rebuilt file needs a new URL (each row's
URL carries its byte count).

## Generated here

| file | what | built by | research |
|---|---|---|---|
| `grb.glb` | George R. Brown Convention Center, Hall B3, 2026 FTC Championship layout | `scripts/venue-models/grb/` | `docs/venues/grb.md` |

Nobody else's work is in it except the repo's own field model (`public/models/biobuzz/field-low.glb`,
FIRST's field CAD, the same file the game draws), copied in for the neighbouring fields.

## Sources and credits

Each file here is credited on the Contributors page (built from its row in
`src/games/biobuzz/graphics/environments.ts`) and below. All are licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the files here are modified
(placed, turned, rescaled, recompressed, parts removed).

| file | title | author | source | licence | what was changed |
|---|---|---|---|---|---|
| `events-stage.glb` | venue stage for great events | QuarizonStudio | https://sketchfab.com/3d-models/venue-stage-for-great-events-d74b3baa5a74430fb3717cfa3d883476 | CC BY 4.0 | placed with the field on its stage; props, seats and rigging textures halved |
| `basketball-court.glb` | Indoor Basketball Court | nguyennghiakk | https://sketchfab.com/3d-models/indoor-basketball-court-943a9bc962974d02aa34592084687c3c | CC BY 4.0 | scaled ×1.12 (rims at 10 ft), turned 90° |
| `aircraft-hangar.glb` | Aircraft Hangar | jimbogies | https://sketchfab.com/3d-models/aircraft-hangar-a5b17ba2e3494873abd313f720097614 | CC BY 4.0 | inches to metres, turned 180°, stray edge triangles removed, textures 1024 and normals 512 |
| (inside `aircraft-hangar.glb`) | Diamond Da42 “Twin Star” | helijah | https://sketchfab.com/3d-models/diamond-da42-twin-star-d83b6e776955401f87f7bc2ad5d5a252 | CC BY 4.0 | kept where the hangar's author parked it, as their page credits it |

Every file also had its lights, cameras and animations removed, and was recompressed (meshopt
geometry, KTX2 textures). The owner turned down two other sources on 2026-11-04 (a badminton hall
and a splat capture); neither ships, and nothing of the splat renderer is left in the repo.
