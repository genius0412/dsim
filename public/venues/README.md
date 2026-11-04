# Venue models (BIOBUZZ 3D)

Processed, compressed venue files only, built by `scripts/venue-models/build.ts` (see its README).
Raw downloads stay outside the repo, in `D:\Projects\dsim\venue-sources\<source id>\`.

No photograph is projected onto geometry here. The photographed venues that lived in this folder
from 2026-10-10 (Poly Haven panoramas projected onto an approximate room) were removed on
2026-11-04: a projection is right only from its own lens, and every in-match camera warped it.

`vercel.json` serves `/venues` immutable for a year, so a rebuilt file needs a new URL (each row's
URL carries its byte count).

## Sources and credits

Each file here is credited on the Contributors page (built from its row in
`src/games/biobuzz/graphics/environments.ts`) and below. All are licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the files here are modified
(placed, turned, rescaled, recompressed, parts removed).

| file | title | author | source | licence | status |
|---|---|---|---|---|---|
| `aircraft-hangar.glb` | Aircraft Hangar | jimbogies | https://sketchfab.com/3d-models/a5b17ba2e3494873abd313f720097614 | CC BY 4.0 | waiting for the download; its DA42 (helijah, CC BY 4.0) is removed |
| `basketball-court.glb` | Indoor Basketball Court | NGUYENNGHIAKK | https://sketchfab.com/3d-models/943a9bc962974d02aa34592084687c3c | CC BY 4.0 | waiting for the download |
| `sports-hall.glb` | Basketball Badminton Hall | flaviafabbri | https://sketchfab.com/3d-models/128c39da6a8e4a8ba169bf87e2d4fa91 | CC BY 4.0 | waiting for the download |
| `events-stage.glb` | Venue stage for great events | QuarizonStudio | https://sketchfab.com/3d-models/d74b3baa5a74430fb3717cfa3d883476 | CC BY 4.0 | waiting for the download |
| (splat trial) | DFK Arena - Antigravity A1 - Niantic Spatial | irobotics_saito | https://superspl.at/scene/f5fa43b3 | CC BY 4.0 | waiting for the download |
