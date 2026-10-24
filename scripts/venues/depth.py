"""
PANORAMA DEPTH FOR THE PHOTOGRAPHED VENUES — stage 1 of `scripts/venues/layers.py`.

Runs MoGe-2 (microsoft/MoGe, MIT code and weights) on twelve 90-degree views of a venue's derived
backdrop (`public/venues/<id>-4k.webp`, so the panorama is turned exactly as the renderer turns it)
and fuses them with MoGe's own gradient-domain merge (log distance, so each view's own scale drops
out). Writes, per venue, under `--out` (default `scratch/venues-depth/<id>/`):

  distance.npy   float32 H x W, distance from the lens along each pixel's ray, MoGe's units
  normal.npy     float32 H x W x 3, unit normals in the renderer's frame (x audience right, z up)
  vis.png        a false-colour look at the distance

The renderer's panorama convention (`photoUv` in `renderPhotoVenue.ts`): u = atan2(-dy, dx)/2pi + 0.5,
v = 0.5 - asin(dz)/pi, v from the image's top row. MoGe's own is turned 180 degrees about z from it;
a distance is the same either way, and the normals are turned back here.

  python scripts/venues/depth.py [--only school-hall,quad] [--views 1024] [--merge 2048]

Needs a CUDA torch and `moge` 2.0 (pre-MoGe-3: it has no Triton dependency, which Windows lacks):
see `scripts/venues/README.md`.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')

import cv2
import numpy as np
from PIL import Image

# torch, utils3d and moge are imported where they are used: `layers.py` and `meshes.py` take
# `renderer_directions` from here, and `meshes.py` runs on a CPU-only box

ROOT = Path(__file__).resolve().parents[2]
VENUES = ['school-hall', 'events-hall', 'hangar', 'court', 'quad']


def renderer_directions(h: int, w: int) -> np.ndarray:
    """unit ray per pixel centre, in the renderer's frame (see the header)"""
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    a = (u - 0.5) * 2 * np.pi
    el = (0.5 - v) * np.pi
    cos_el = np.cos(el)[:, None]
    return np.stack(
        [np.cos(a)[None, :] * cos_el, -np.sin(a)[None, :] * cos_el, np.broadcast_to(np.sin(el)[:, None], (h, w))],
        axis=-1,
    ).astype(np.float32)


def moge_directions(h: int, w: int) -> np.ndarray:
    """MoGe's `spherical_uv_to_directions` for the same pixel centres"""
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    theta = (1 - u)[None, :] * 2 * np.pi
    phi = v[:, None] * np.pi
    return np.stack(
        [np.sin(phi) * np.cos(theta), np.sin(phi) * np.sin(theta), np.broadcast_to(np.cos(phi), (h, w))], axis=-1
    ).astype(np.float32)


def merge_normals(h: int, w: int, normals: list[np.ndarray], masks: list[np.ndarray], extrinsics, intrinsics) -> np.ndarray:
    """each view's camera-frame normals turned into MoGe's panorama frame and averaged where views
    overlap, weighted toward each view's centre"""
    import utils3d

    dirs = moge_directions(h, w)
    acc = np.zeros((h, w, 3), np.float32)
    wsum = np.zeros((h, w), np.float32)
    for n, m, ext, intr in zip(normals, masks, extrinsics, intrinsics):
        uv, depth = utils3d.np.project_cv(dirs, extrinsics=ext, intrinsics=intr)
        valid = (depth > 0) & (uv > 0).all(-1) & (uv < 1).all(-1)
        px = utils3d.np.uv_to_pixel(np.clip(uv, 0, 1), n.shape[:2]).astype(np.float32)
        nv = cv2.remap(n, px[..., 0], px[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        mv = cv2.remap(m.astype(np.uint8), px[..., 0], px[..., 1], cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE) > 0
        # camera (OpenCV: x right, y down, z forward) to world: R^T
        rot = ext[:3, :3].T
        nw = nv @ rot.T
        # weight: 1 at the view centre, 0 at its edge
        cw = np.clip(1 - 2 * np.max(np.abs(uv - 0.5), axis=-1), 0, 1)
        wgt = np.where(valid & mv, cw, 0).astype(np.float32)
        acc += nw * wgt[..., None]
        wsum += wgt
    out = acc / np.clip(wsum, 1e-6, None)[..., None]
    out /= np.clip(np.linalg.norm(out, axis=-1, keepdims=True), 1e-6, None)
    return out


def run(venue: str, model: MoGeModel, device, view_res: int, merge_w: int, out_root: Path) -> None:
    import torch
    import utils3d
    from moge.utils.panorama import get_panorama_cameras, merge_panorama_depth, split_panorama_image

    src = ROOT / 'public' / 'venues' / f'{venue}-4k.webp'
    image = np.array(Image.open(src).convert('RGB'))
    exts, intrs = get_panorama_cameras()
    views = split_panorama_image(image, exts, intrs, view_res)
    dists, masks, normals = [], [], []
    for i in range(0, len(views), 2):
        batch = torch.tensor(np.stack(views[i : i + 2]) / 255, dtype=torch.float32, device=device).permute(0, 3, 1, 2)
        fov_x, _ = np.rad2deg(utils3d.np.intrinsics_to_fov(np.array(intrs[i : i + 2])))
        out = model.infer(batch, fov_x=torch.tensor(fov_x, dtype=torch.float32, device=device), apply_mask=False, resolution_level=9)
        dists.extend(list(out['points'].norm(dim=-1).cpu().numpy()))
        masks.extend(list(out['mask'].cpu().numpy()))
        normals.extend(list(out['normal'].cpu().numpy()))
    mw, mh = merge_w, merge_w // 2
    dist, _ = merge_panorama_depth(mw, mh, dists, masks, exts, intrs)
    dist = dist.astype(np.float32)
    nrm_moge = merge_normals(mh, mw, normals, masks, exts, intrs)
    # MoGe's frame to the renderer's: turned 180 degrees about z
    nrm = nrm_moge * np.array([-1, -1, 1], np.float32)
    out_dir = out_root / venue
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / 'distance.npy', dist)
    np.save(out_dir / 'normal.npy', nrm.astype(np.float32))
    vis = np.log(dist)
    vis = (vis - np.percentile(vis, 1)) / (np.percentile(vis, 99) - np.percentile(vis, 1))
    vis = cv2.applyColorMap((np.clip(vis, 0, 1) * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
    cv2.imwrite(str(out_dir / 'vis.png'), vis)
    cv2.imwrite(str(out_dir / 'normal.png'), cv2.cvtColor(((nrm * 0.5 + 0.5) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    print(venue, dist.shape, float(np.median(dist)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--views', type=int, default=1024, help='pixels per 90-degree view')
    ap.add_argument('--merge', type=int, default=2048, help='width of the fused panorama')
    ap.add_argument('--out', default=str(ROOT / 'scratch' / 'venues-depth'))
    ap.add_argument('--model', default='Ruicheng/moge-2-vitl-normal')
    args = ap.parse_args()
    import torch
    from moge.model.v2 import MoGeModel

    device = torch.device('cuda')
    model = MoGeModel.from_pretrained(args.model).to(device).eval()
    for v in args.only.split(',') if args.only else VENUES:
        run(v, model, device, args.views, args.merge, Path(args.out))


if __name__ == '__main__':
    main()
