# Rebuilding three venue rooms (needs a CUDA GPU)

Branch `perf/3d-preload-venues` (PR #123). Three photographed venues were re-measured off their own
panoramas, and the fixes are in the pipeline inputs only. The shipped files and the
`environments.ts` rows are unchanged until this runs. Run the whole pipeline on a machine with an
NVIDIA GPU, then commit the files and rows together, because the RENDER lane holds them to each other.

## What changed, and why

| venue | fix | measured from |
|---|---|---|
| hangar | the photo is turned 18° against its box: `yaw` 90 → **72** (`venues.cjs`). New box x −709…857, y ±435, with a gable roof (eave 328, crown 483) | door at az 18.5°; both side walls at 17.6° and 18.6°; roof spine 18° |
| school-hall | the auditorium is **44 in** below the stage (it was 25.3), and the stage edge is a polyline with two thrusts (it was y = 80) | six front-row seat fronts over their feet |
| events-hall | a gable roof, eave 145 and ridge ~250 (it was a flat 300) | the end-wall gable peaks, 14.5° and 18° up |

All three live in `layers.py` (`ROOMS`, `FLOOR_STEPS`, `room_distance` gains a gable and a polyline
step). Court (64.6 in lens) is already shipped. Quad needs nothing.

## Requirements

- An NVIDIA GPU with 8 GB+ VRAM; 12 GB is safer. The peak is LaMa at 2560 × 1024, which has not
  been measured on an 8 GB card.
- `nvidia-smi` reports CUDA 12.8 or newer.
- Python 3.11.
- ~12 GB of disk: ~6 GB for the venv, ~2.5 GB of weights on the first run.
- The usual checkout with real Zenith tarballs, for `npm test` / `build`.

## 1. Python env (once)

Keep it outside the repo. It was `D:\ml\dsim-venues` last time; if that still exists, reuse it.

```powershell
py -3.11 -m venv D:\ml\dsim-venues
D:\ml\dsim-venues\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"   # True + your GPU
git clone https://github.com/microsoft/MoGe D:\ml\MoGe
git -C D:\ml\MoGe checkout 925b8ed          # MoGe 2.0 — MoGe 3 needs Triton, which Windows lacks
pip install -e D:\ml\MoGe
pip install "transformers<5" simple-lama-inpainting opencv-python-headless scipy
```

## 2. Run it

From the repo root on `perf/3d-preload-venues`. Use Git Bash, with the venv's `python` on PATH.

```bash
# the turned hangar backdrop (needs the Poly Haven 4k HDR; derive checks its md5)
env -u ELECTRON_RUN_AS_NODE npx electron scripts/venues/derive.cjs --only hangar

# GPU: ~15–30 min for the three, plus weight downloads on the first run
python scripts/venues/depth.py  --only school-hall,events-hall,hangar
python scripts/venues/layers.py --only school-hall,events-hall,hangar

# CPU
python scripts/venues/meshes.py --only school-hall,events-hall,hangar
npx tsx scripts/venues/pack.ts   --only school-hall,events-hall,hangar
node scripts/venues/sync-env.mjs --only school-hall,events-hall,hangar
```

`derive.cjs` writes `public/venues/hangar-{4k,2k}.webp` and `hangar-ibl.hdr`. The expected sizes
are 1,331,394 / 343,558 / 430,660 bytes; anything else means the yaw did not take.

`sync-env.mjs` writes each row's `PHOTO_FILES` sizes, `height`, `room` (with `eave`/`ridgeY` for the
gables), `PHOTO_LAYERS` rows/sizes and the stage rectangle from `meta.json` and `pack.json`.

## 3. Hand edits

1. `public/venues/README.md`, hangar row: yaw `90` → `72`, sizes `1331394 | 343558 | 430660`.
2. `environments.ts`, hangar row:
   - `rig.sun` `[61, 115, 109]` → `[94, 90, 109]`: the window light turned −18° with the photo.
   - In its comment, "Turned 90°" → 72°, and fieldlight az 64° → 46°.
   - Re-read with `node scripts/venues/fieldlight.cjs public/venues/hangar-ibl.hdr`.
3. The stage drop is now **44 in**, not 25/30. Fix the prose in three places:
   - `PhotoLayers.floor`'s doc;
   - the `renderPhotoVenue.ts` header (THE LAYERED ROOM);
   - the "draw nothing flat" paragraph in `docs/area/biobuzz.md`.
4. Delete the `PENDING REBUILD` notes in `layers.py` and `venues.cjs`, and the pending list in
   `scripts/venues/README.md`.

## 4. Verify and commit

```bash
npx tsx scripts/smoke-biobuzz/index.ts --lane render   # 0 FAIL; adds a gable-eave check
npm test
npm run build
```

Then capture Home, Play and a started solo match in all three venues (offscreen Electron or
`/verify`), from both driver sides. Look for three things:
- the hangar's walls and door square to the field;
- the school hall's stage edge and thrusts, with the auditorium 44 in down;
- the events hall's roof slopes.

Commit `public/venues/{hangar,school-hall,events-hall}-*`, `environments.ts` and the doc edits in
one commit.

Side effect to look at: orbit/free cameras are held under `ceil` (now the ridge) − 30 in. Near a
side wall they can rise above the sloped roof plane and see the room as a cutaway.

## Troubleshooting

| symptom | fix |
|---|---|
| `torch.cuda.is_available()` is False | update the driver (CUDA ≥ 12.8), then `pip install --force-reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu128`. A GTX 10-series card that says "no kernel image" needs `cu126` instead |
| `No module named 'moge.model.v2'`, or anything about triton | wrong MoGe: `git -C D:\ml\MoGe checkout 925b8ed` and `pip install -e` again |
| `module 'utils3d' has no attribute 'np'` | `pip install --force-reinstall "utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183"` |
| "compiled with NumPy 1.x cannot run in NumPy 2" | `pip install "numpy<2"` (`simple-lama-inpainting` pins numpy 1.x / pillow 9.x; that's expected) |
| CUDA out of memory | one venue at a time, and set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| both `opencv-python` and `-headless` installed | `pip uninstall opencv-python-headless` |

## Not in this rebuild (needs its own measurement)

- **Events hall:** turned ~5–6° against its box (yaw ≈ −26, not −20), and its end walls look ~50 in
  off. Its derive furniture patch lives in that frame, so redo both together.
- **Hangar:** the end wall's recessed middle bay (−14.5 lens heights) and the airfield through the
  open door.
- **Court:** the see-through fence and the sky ceiling.
- **Quad:** the layered +y side (curb, walkway, door wall), the canopy and the open ends.
- **School hall:** the proscenium arch and the stage house.
