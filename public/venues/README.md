# Photographed venues (BIOBUZZ 3D)

DERIVED files, not the photographs as published: each is built from the Poly Haven 4k `.hdr`
named below by `scripts/venues/derive.cjs`, which checks the source md5 first. Rebuild with

    npx electron scripts/venues/derive.cjs

(`env -u ELECTRON_RUN_AS_NODE` first in a shell that sets it). Per venue:

- `<id>-4k.webp`, `<id>-2k.webp` — the backdrop: linear light through `e = v / (1 + v)`,
  `v = gain × x`, stored sRGB; the renderer inverts it before its own tone mapping. Turned by
  `yaw` degrees so the room lines up with the field.
- `<id>-ibl.hdr` — the light-gathering map: 512 × 256 RGBE, linear, box-filtered from the 4k
  (energy-conserving), same turn.

Same origin on purpose: a Discord Activity's CSP refuses `dl.polyhaven.org`, and these load
there like any other file of the site.

All sources are CC0 1.0 (https://polyhaven.com/license); credit is given anyway, on the
Contributors page (built from `src/games/biobuzz/graphics/environments.ts`) and here.

| id | source | 4k .hdr md5 | authors | yaw | gain | WebP q | clean-up | 4k | 2k | ibl |
|---|---|---|---|---|---|---|---|---|---|---|
| school-hall | [school_hall](https://polyhaven.com/a/school_hall) (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/school_hall_4k.hdr) | `aa26139e09ebc81137abb429bc31a39c` | Dimitrios Savva (Photography), Jarod Guest (Processing) | 180 | 1.3 | 0.9 | patch θ 90…109°, e -41…-17° from -22° round; patch θ 46…63°, e -47…-34° from 17° round | 726594 | 221352 | 430592 |
| events-hall | [events_hall_interior](https://polyhaven.com/a/events_hall_interior) (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/events_hall_interior_4k.hdr) | `1b03b3cba4a059c2a59cbce336fe08c3` | Dimitrios Savva (Photography), Jarod Guest (Processing) | -20 | 1 | 0.9 | patch θ 26…170°, e -62…-3.5° from the room's mirror; de-gloss e -80…-4° | 785528 | 249240 | 427861 |
| hangar | [small_hangar_01](https://polyhaven.com/a/small_hangar_01) (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/small_hangar_01_4k.hdr) | `14ec4d5609dd2e8a1f847ae9a4a54a32` | Sergej Majboroda (All) | 72 | 1.5 | 0.9 | — | 1331394 | 343558 | 430660 |
| court | [netball_court](https://polyhaven.com/a/netball_court) (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/netball_court_4k.hdr) | `537240c4f74f5d7eefa4e3af81c22a51` | Dimitrios Savva (Photography), Jarod Guest (Processing) | -55 | 2.5 | 0.9 | — | 438074 | 116978 | 375051 |
| quad | [school_quad](https://polyhaven.com/a/school_quad) (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/school_quad_4k.hdr) | `ddecfc04a5f94a3a6834883fe47492e0` | Dimitrios Savva (Photography), Jarod Guest (Processing) | 0 | 1.1 | 0.9 | — | 1436898 | 436626 | 449016 |

Sizes are bytes.

## The layered room

`<id>-bg-4k.webp`, `<id>-bg-2k.webp` (the backdrop with its furniture inpainted out),
`<id>-fg-4k.webp`, `<id>-fg-2k.webp` (the original backdrop, the furniture's rows only) and
`<id>-room.glb` (the room and furniture meshes) are derived from the backdrops above by the
pipeline in `scripts/venues/README.md` (MoGe-2 depth, OneFormer segmentation, LaMa inpainting;
MIT, MIT and Apache-2.0). Rerun it after this script.
