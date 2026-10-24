# Rebuilding three venue rooms on a CUDA GPU

Hi, and thanks for helping. DSIM is an FTC driver-practice sim. Its 3D venues are 360° photos turned
into a room you can drive around in, and three of those rooms were measured wrong. The fix needs
two AI passes that only run on an NVIDIA GPU, and the PC this is built on has none. You run those
two passes and zip up what they write. Plan on about an hour, most of it downloads.

## What you need

- **An NVIDIA GPU with 8 GB of VRAM or more. 12 GB is safer.** The depth model (MoGe-2 ViT-L) and
  the segmentation model (OneFormer Swin-L) need roughly 3–6 GB. The heaviest step is the last one,
  LaMa inpainting on a 2560 × 1024 image. Nobody has tried this on an 8 GB card yet.
- A recent NVIDIA driver. `nvidia-smi` should show **CUDA Version 12.8 or higher**.
- **Python 3.11** and **git**.
- **About 12 GB of free disk**: ~6 GB for the Python environment, ~2.5 GB for model weights
  (downloaded on the first run), ~0.5 GB for the outputs.
- Internet for the first run (PyTorch, the three models from Hugging Face and GitHub).
- Windows 10/11 or Linux both work. Nothing here needs Node or the rest of the repo.

You will also get **one file from the DSIM owner, `hangar-4k.webp`** (1,331,394 bytes). It is the
hangar photo turned 18°, the hangar's main fix. Have it before step 3.

## 1. Set up (once)

**Windows (PowerShell).** Keep the folder short, because Windows has trouble with long paths:

```powershell
mkdir C:\dsim-gpu; cd C:\dsim-gpu
git clone --depth 1 --branch perf/3d-preload-venues --filter=blob:none --sparse https://github.com/genius0412/dsim.git
cd dsim
git sparse-checkout set scripts/venues public/venues
py -3.11 -m venv C:\dsim-gpu\venv
C:\dsim-gpu\venv\Scripts\Activate.ps1      # blocked? run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
git clone https://github.com/microsoft/MoGe C:\dsim-gpu\MoGe
git -C C:\dsim-gpu\MoGe checkout 925b8ed
pip install -e C:\dsim-gpu\MoGe
pip install "transformers<5" simple-lama-inpainting
```

**Linux (bash):**

```bash
mkdir -p ~/dsim-gpu && cd ~/dsim-gpu
git clone --depth 1 --branch perf/3d-preload-venues --filter=blob:none --sparse https://github.com/genius0412/dsim.git
cd dsim
git sparse-checkout set scripts/venues public/venues
python3.11 -m venv ~/dsim-gpu/venv
source ~/dsim-gpu/venv/bin/activate
python -m pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
git clone https://github.com/microsoft/MoGe ~/dsim-gpu/MoGe
git -C ~/dsim-gpu/MoGe checkout 925b8ed
pip install -e ~/dsim-gpu/MoGe
pip install "transformers<5" simple-lama-inpainting
```

The `torch` check line must print `True` and your GPU's name. If it doesn't, see Troubleshooting.

Some notes on the versions:
- **MoGe must be 2.0** (commit `925b8ed`). MoGe 3 needs Triton, which does not exist on Windows.
- `simple-lama-inpainting` downgrades numpy to 1.x and pillow to 9.x. That's expected and fine.
- The sparse clone fetches only `scripts/venues/` (the Python) and `public/venues/` (the photos,
  ~16 MB). The Python imports nothing else from the repo.

## 2. Put the hangar file in place

Copy the `hangar-4k.webp` you were sent over `dsim/public/venues/hangar-4k.webp` (replace it). Then
check the size. It must be **1331394**. The old file is 1329858, and the hangar comes out wrong if
you run step 3 on that one.

```powershell
(Get-Item public\venues\hangar-4k.webp).Length     # Windows
```
```bash
stat -c %s public/venues/hangar-4k.webp             # Linux
```

## 3. Run the two GPU passes

From the `dsim` folder, with the venv active:

```bash
python scripts/venues/depth.py  --only school-hall,events-hall,hangar
python scripts/venues/layers.py --only school-hall,events-hall,hangar
```

- `depth.py` runs MoGe-2 on twelve views per venue and writes `scratch/venues-depth/<venue>/`.
- `layers.py` runs OneFormer and LaMa and writes `scratch/venues-layers/<venue>/`.

The first run downloads ~2.5 GB of weights: MoGe-2 ~1.3 GB, OneFormer ~0.9 GB, LaMa ~0.2 GB. After
that, expect a few minutes per venue per pass on a modern card, so roughly **15–30 minutes** for
everything. Each venue prints a line when it finishes.

Only these three venues are run because only their rooms changed. Re-running the other two would
just give slightly different bytes for no gain.

## 4. Check it worked

```bash
python -c "import json,numpy as np; [print(v, np.load(f'scratch/venues-layers/{v}/bg_distance.npy').shape, int((np.load(f'scratch/venues-layers/{v}/fg_distance.npy')>0).sum()), json.load(open(f'scratch/venues-layers/{v}/meta.json'))['room']) for v in ['school-hall','events-hall','hangar']]"
```

Each line should show `(1024, 2048)`, a furniture-pixel count in the thousands to tens of
thousands, and the room. The hangar's room must read `'x0': -709 … 'eave': 328`. If it says `-737`,
your checkout is not the right branch.

Each `scratch/venues-layers/<venue>/` should hold `bg_distance.npy` and `fg_distance.npy` (~8 MB
each), `bg-4k.png` (~15–25 MB), `bg.png`, `fg_mask.png`, `p_struct.png` and `meta.json`. Open
`bg.png` if you're curious: it's the panorama with the furniture painted out.

## 5. Send it back

Zip the `scratch` folder's two subfolders (~150–250 MB) and share the zip with Google Drive,
WeTransfer or similar. Discord's upload limit is too small.

```powershell
Compress-Archive -Path scratch\venues-layers, scratch\venues-depth -DestinationPath dsim-venues-gpu.zip
```
```bash
zip -r dsim-venues-gpu.zip scratch/venues-layers scratch/venues-depth
```

`venues-layers` is the part that's needed. `venues-depth` is optional (skip it if the upload is too
big), but having it means a later tweak of the layers pass won't need MoGe again.

## Troubleshooting

- **`torch.cuda.is_available()` is `False`.** Either the CPU build of torch got installed or the
  driver is too old. Run `nvidia-smi`: it needs CUDA ≥ 12.8, so update the driver if not. Then
  reinstall torch:
  `pip install --force-reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu128`.
  On an old GTX 10-series card that says "no kernel image is available", use `.../whl/cu126` in
  that line instead.
- **`No module named 'moge.model.v2'`, or anything about `triton`.** You have the wrong MoGe. Run
  `git -C <MoGe folder> checkout 925b8ed`, then `pip install -e <MoGe folder>` again.
- **`module 'utils3d' has no attribute 'np'`.** You have the wrong utils3d. Run
  `pip install --force-reinstall "utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183"`.
- **"A module compiled with NumPy 1.x cannot run in NumPy 2".** Run `pip install "numpy<2"`.
- **CUDA out of memory.** Close games and browsers, and run one venue at a time (`--only hangar`,
  then the next). Also set this before running: PowerShell
  `$env:PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"`, bash
  `export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`. If `layers.py` still runs out of
  memory near the end (that's LaMa), tell the owner your card and VRAM.
- **Downloads fail or stall.** The models come from huggingface.co and github.com. Retry, or try
  another network. They're cached afterwards (`~/.cache/huggingface`, `~/.cache/torch`).
- **Windows "filename too long" during pip or git.** Run `git config --global core.longpaths true`
  and keep everything under a short folder like `C:\dsim-gpu`.
- **Errors about OpenCV after installing.** Check `pip list | findstr opencv` (Windows) or
  `pip list | grep opencv` (Linux). If both `opencv-python` and `opencv-python-headless` are
  there, `pip uninstall opencv-python-headless`.

---

## For the DSIM owner, after the zip comes back

Run everything from the repo root in Git Bash, on `perf/3d-preload-venues`.

**Before sending this runbook:** build the turned hangar backdrop without touching `public/` and
send the friend `scratch/venues-derived/hangar-4k.webp`. It was already built once on 2026-10-24
(4k 1,331,394 / 2k 343,558 / ibl 430,660 bytes), and building it again gives the same bytes:

```bash
env -u ELECTRON_RUN_AS_NODE npx electron scripts/venues/derive.cjs --only hangar --out scratch/venues-derived
```

**After the zip:**

```bash
unzip dsim-venues-gpu.zip -d .            # -> scratch/venues-layers/<id>/ (+ scratch/venues-depth/)
cp scratch/venues-derived/hangar-4k.webp scratch/venues-derived/hangar-2k.webp scratch/venues-derived/hangar-ibl.hdr public/venues/
pip install numpy opencv-python-headless scipy pillow     # meshes.py is CPU-only (no torch, no moge)
python scripts/venues/meshes.py --only school-hall,events-hall,hangar
npx tsx scripts/venues/pack.ts --only school-hall,events-hall,hangar
node scripts/venues/sync-env.mjs --only school-hall,events-hall,hangar
```

`sync-env.mjs` writes each row's `PHOTO_FILES` sizes, `height`, `room` (with `eave` and `ridgeY`
for the two gable roofs), and `PHOTO_LAYERS` rows, sizes and stage rectangle from `meta.json` and
`pack.json`. It also updates the picker note.

Then a few edits by hand:
1. `public/venues/README.md`, hangar row: yaw `90` → `72`, sizes `1331394 | 343558 | 430660`. A
   plain `derive.cjs --only` does not rewrite the README.
2. `environments.ts`, hangar row: `rig.sun` `[61, 115, 109]` → `[94, 90, 109]` (the window light
   turned −18° with the photo, still at 40°). In its comment, "Turned 90°" becomes 72° and
   `fieldlight` az 64° becomes 46°. You can re-read the new value with
   `node scripts/venues/fieldlight.cjs public/venues/hangar-ibl.hdr`.
3. The stage drop is now **44 in**, not 25/30 in. Update the prose that says otherwise:
   `PhotoLayers.floor`'s doc (`environments.ts`), the header of `renderPhotoVenue.ts` (THE LAYERED
   ROOM), and the "draw nothing flat" paragraph in `docs/area/biobuzz.md`.
4. Remove the `PENDING REBUILD` notes in `layers.py` and `venues.cjs`, and the pending list in
   `scripts/venues/README.md`.

Verify:

```bash
npx tsx scripts/smoke-biobuzz/index.ts --lane render     # 0 FAIL; the hangar and events hall add a gable-eave check
npm run build
```

Then do the capture check, the same one as HANDOFF 2026-10-24: `ELECTRON=1 npm run build`, then
offscreen Electron captures (or `/verify`) of Home, Play and a started solo match in the school
hall, events hall and hangar. Look at the hangar's walls and door (now square to the field), the
school hall's stage edge and thrusts (the auditorium sits 44 in down), and the events hall's roof
slopes. Commit `public/venues/{hangar,school-hall,events-hall}-*` and `environments.ts` together:
the render lane holds the files and the rows to each other.
