# The photographed venues' files

Everything under `public/venues/` is derived here. Two pipelines:

1. **`derive.cjs`**: the backdrop (`<id>-4k.webp`, `<id>-2k.webp`) and the light-gathering map
   (`<id>-ibl.hdr`), from Poly Haven's 4k `.hdr` (see `public/venues/README.md`).
2. **The layered room** (2026-10-24): what lets the renderer draw a venue with nothing flat on its
   floor (`src/games/biobuzz/scene/renderPhotoVenue.ts`, THE LAYERED ROOM). It runs on the
   backdrops `derive.cjs` wrote, so rerun it after them.

## The layered room

| stage | script | writes |
|---|---|---|
| depth | `depth.py` | `scratch/venues-depth/<id>/distance.npy`, `normal.npy`: MoGe-2 on twelve 90° views, fused |
| layers | `layers.py` | `scratch/venues-layers/<id>/`: furniture depth, its mask, the inpainted panorama |
| meshes | `meshes.py` | raw meshes (scratch) and `public/venues/<id>-bg-{4k,2k}.webp`, `<id>-fg-{4k,2k}.webp` |
| pack | `pack.ts` | `public/venues/<id>-room.glb` (meshopt, quantised; the importer's format) |
| sync | `sync-env.mjs` | each row's `PHOTO_LAYERS(...)` rows and sizes, and the picker note, in `environments.ts` |
| rescale | `rescale-lens.ts` | only when a lens is RE-MEASURED: `public/venues/<id>-room.glb` scaled about the lens, no GPU |

```
python scripts/venues/depth.py
python scripts/venues/layers.py
python scripts/venues/meshes.py
npx tsx scripts/venues/pack.ts
node scripts/venues/sync-env.mjs
npx tsx scripts/smoke-biobuzz/index.ts --lane render    # the files, the rows and the meshes agree
```

(`--only <id,id>` on each.)

### The lens height is per venue

Every room was read off its photograph in LENS HEIGHTS, so each venue's lens (`PhotoVenue.height`,
measured off its own photograph — `PHOTO_LENS_IN`'s note in `environments.ts`) sets the size of its
whole room against the field. `layers.py` carries it per venue (`LENS`, with `eye(venue)`), and
`meshes.py` takes it from there; `ROOMS` and `FLOOR_STEPS` must equal the rows (the RENDER lane
compares the meshes with them).

A re-measured lens does not need the GPU stages. Everything scales about the lens by
k = new / old: the floor stays at `PHOTO_FLOOR_Z`, the lens moves, and a direction from it is
unchanged, so the photograph's lookup, the furniture's rows and the split at the lens all hold.

```
npx tsx scripts/venues/rescale-lens.ts --only court --from 63 --to 64.6   # prints the new size
```

then, by the same k, the row's `room` (and its `PhotoLayers.floor`), `layers.py`'s `ROOMS`,
`FLOOR_STEPS` (`y0` × k; `z` → `FLOOR_Z + k (z − FLOOR_Z)`) and `LENS`; the row's `height`; the
printed size into the row's `bytes.mesh`; and the RENDER lane. A derive patch's `room`
(`venues.cjs`) is in lens heights and does not change. The court was rescaled this way on
2026-10-24 (63 → 64.6 in). Run the Python stages from `scripts/venues/` with a Python that has:

- a CUDA `torch` (`pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128`);
- `moge` **2.0** (`git clone https://github.com/microsoft/MoGe`, `git checkout 925b8ed`,
  `pip install -e .`). MoGe 3 depends on Triton through FlexGEMM, which Windows lacks;
- `transformers`, `opencv-python-headless`, `scipy`, `simple-lama-inpainting`.

Keep that environment out of the repo (it is several GB). It was set up in `D:\ml\dsim-venues`.

### The models (weights download on first use; none is committed)

| model | job | licence |
|---|---|---|
| MoGe-2, `Ruicheng/moge-2-vitl-normal` | metric depth and normals per view | MIT |
| OneFormer, `shi-labs/oneformer_ade20k_swin_large` | which pixels are room, which are furniture (ADE20K) | MIT |
| LaMa (`big-lama`, via `simple-lama-inpainting`) | the room behind the furniture | Apache-2.0 |

### Rules, each measured

- **THE ROOM IS THE MEASURED BOX** (with a venue's floor step, `FLOOR_STEPS`), not MoGe's room.
  MoGe's walls are a few per cent of noise, and a closed mesh bridges every jump in its depth with a
  sheet that is a smear seen from off the lens. A blur that hid the jumps turned every floor/wall
  junction into a ramp, and the school hall's auditorium into a warped funnel. The box never smeared
  the room; it smeared the furniture.
- **MoGe IS BENT ONTO THE ROOM, SMOOTHLY** (`shell_correction`). Fitted on the floor near the field,
  it reads the far walls 6–15 % deep. A per-pixel snap within a tolerance left snapped and unsnapped
  patches of one wall at different depths.
- **FURNITURE IS WHAT THE CLASSES SAY, OR WHAT STANDS WELL CLEAR OF THE ROOM BELOW THE LENS**, and
  it is drawn only where it stands clear of the room behind it: 3 % for what the classes are sure of
  (the school hall's back rows are that close to its wall), 10 % otherwise. Below that it draws right
  painted on the wall and wrong as a relief off it (the school hall's doorway, half taken for an
  object, floated as a white band).
- **EVERYTHING THE CLASSES ARE SURE IS FURNITURE IS PAINTED OUT**, drawn as relief or not. Left in,
  LaMa copied it into every gap, and the floor behind the seats came out tiled with ghost chairs.
- **FURNITURE IS BLURRED ~1° INSIDE ITS OUTLINE, NO MORE** (`meshes.py`). Unblurred, a seat block
  cut into shards with spikes; blurred three times as far, it became a near-flat sheet with the
  chairs painted on it, which is the floor smear again. What is still seen edge-on is dropped in the
  shader (`PHOTO_STRETCH_MAX`).
- **THE ROOM MESH IS EVALUATED AT ITS OWN RAYS.** Resampling a depth map to the grid put far walls
  3 in off at a grazing ray (the RENDER lane caught it on the court).
