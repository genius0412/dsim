"""
THE TWO LAYERS AS MESHES AND TEXTURES — stage 3, after `layers.py`; `pack.ts` packs the meshes.

Per venue:
  scratch/venues-layers/<id>/mesh-<part>-pos.npy, -idx.npy   raw meshes in field inches (z up, the
      lens at the field's centre), wound away from the lens (the box's `BackSide` sense):
        bg-lo, bg-hi   the room, closed round the lens, split at the lens height so the top-down
                       cameras can leave the upper half out
        fg-lo, fg-hi   the furniture, cut wherever its depth jumps (a chair's edge against the floor
                       behind it) or it is seen edge-on, so nothing is stretched across a gap
  public/venues/<id>-bg-4k.webp, -bg-2k.webp   the backdrop with the furniture inpainted out
  public/venues/<id>-fg-4k.webp, -fg-2k.webp   the ORIGINAL backdrop, the furniture's rows only
and prints each venue's `fgRows` and byte counts for `environments.ts`.

  python scripts/venues/meshes.py [--only quad]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import label

from depth import renderer_directions
from layers import EYE, FLOOR_STEPS, LENS_IN, ROOMS, room_distance

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'venues'
BG_GRID = 1024
# a furniture triangle whose corners' distances differ by more than this share is an occlusion edge
# (one object in front of another: the piano in front of the seats)
FG_RTOL = 0.06
# the furniture's depth blur inside each outline, pixels of the 2048-wide panorama (~1 degree). Not
# more: a block of seats blurred three times as far became a near-flat sheet with the chairs painted
# on it, which is the floor smear again seen from the side. The relief's own sheets between rows
# are dropped by the renderer instead (`PHOTO_STRETCH_MAX`).
FG_BLUR_PX = 6.0
# ...and one seen nearly edge-on from the lens is the same edge at a slant
FG_GRAZE = 0.1
WEBP_Q = 90


def outward(verts: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """wind every triangle so its normal points away from the lens"""
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    n = np.cross(v1 - v0, v2 - v0)
    c = (v0 + v1 + v2) / 3 - EYE
    flip = np.einsum('ij,ij->i', n, c) < 0
    tris = tris.copy()
    tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris


def grid_tris(h: int, w: int) -> np.ndarray:
    idx = np.arange(h * w).reshape(h, w)
    right = np.roll(idx, -1, axis=1)
    a, b, c, d = idx[:-1], right[:-1], idx[1:], right[1:]
    return np.concatenate([np.stack([a, c, b], -1).reshape(-1, 3), np.stack([b, c, d], -1).reshape(-1, 3)])


def bg_mesh(venue: str) -> tuple[np.ndarray, np.ndarray]:
    """the room: a closed grid round the lens on the measured room (`room_distance`, the same one
    `layers.py` put behind the furniture), evaluated at the grid's own rays so every vertex lies on
    its wall exactly (a depth map resampled to the grid put far walls inches off at a grazing ray)"""
    h, w = BG_GRID // 2, BG_GRID
    dirs = renderer_directions(h, w)
    d = room_distance(dirs, ROOMS[venue], FLOOR_STEPS.get(venue))
    pts = (EYE + dirs * d[..., None]).reshape(-1, 3)
    top = EYE + np.array([0, 0, 1], np.float32) * float(np.median(d[0]))
    bottom = EYE + np.array([0, 0, -1], np.float32) * LENS_IN
    verts = np.vstack([pts, top, bottom]).astype(np.float32)
    idx = np.arange(h * w).reshape(h, w)
    ti, bi = h * w, h * w + 1
    caps = np.concatenate([
        np.stack([np.full(w, ti), idx[0], np.roll(idx[0], -1)], -1),
        np.stack([np.full(w, bi), np.roll(idx[-1], -1), idx[-1]], -1),
    ])
    return verts, outward(verts, np.concatenate([grid_tris(h, w), caps]))


def smooth_furniture(d_fg: np.ndarray, d_bg: np.ndarray) -> np.ndarray:
    """each object's depth blurred inside its own outline (a normalised convolution of the log
    distance over the mask, ~1 degree): MoGe's relief of a block of seats is every chair back and
    every gap between rows, and cut at each of those it was a field of shards with spikes seen from a
    driver's corner. The result stays in front of the room."""
    valid = d_fg > 0
    logd = np.where(valid, np.log(np.where(valid, d_fg, 1)), 0).astype(np.float32)
    m = valid.astype(np.float32)
    num = cv2.GaussianBlur(logd, (0, 0), FG_BLUR_PX)
    den = cv2.GaussianBlur(m, (0, 0), FG_BLUR_PX)
    out = np.exp(num / np.maximum(den, 1e-6))
    return np.where(valid, np.minimum(out, d_bg * 0.97), 0).astype(np.float32)


def fg_mesh(d_fg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """the furniture at full resolution, cut at every occlusion edge left after the smoothing"""
    h, w = d_fg.shape
    valid = (d_fg > 0).reshape(-1)
    dist = np.where(d_fg > 0, d_fg, 1).astype(np.float32)
    verts = (EYE + renderer_directions(h, w) * dist[..., None]).reshape(-1, 3).astype(np.float32)
    tris = grid_tris(h, w)
    tris = tris[valid[tris].all(1)]
    dt = dist.reshape(-1)[tris]
    tris = tris[dt.max(1) / dt.min(1) < 1 + FG_RTOL]
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    n = np.cross(v1 - v0, v2 - v0)
    n /= np.clip(np.linalg.norm(n, axis=1, keepdims=True), 1e-9, None)
    c = (v0 + v1 + v2) / 3 - EYE
    c /= np.linalg.norm(c, axis=1, keepdims=True)
    tris = tris[np.abs(np.einsum('ij,ij->i', n, c)) > FG_GRAZE]
    return compact(verts, outward(verts, tris))


def compact(verts: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    used = np.unique(tris)
    remap = -np.ones(len(verts), np.int64)
    remap[used] = np.arange(len(used))
    return verts[used], remap[tris].astype(np.uint32)


def split_at_lens(verts: np.ndarray, tris: np.ndarray):
    cz = verts[tris].mean(1)[:, 2]
    return compact(verts, tris[cz < EYE[2]]), compact(verts, tris[cz >= EYE[2]])


def fg_rows(d_fg: np.ndarray) -> tuple[float, float]:
    """the furniture's rows as a share of the panorama's height, with a margin, on a 4-row grid of
    the 4k image's 2048 rows"""
    rows = np.nonzero((d_fg > 0).any(1))[0]
    h = d_fg.shape[0]
    if len(rows) == 0:
        return 0.5, 0.5 + 4 / 2048
    top = max(0, int(np.floor((rows[0] - 4) / h * 2048 / 4) * 4))
    bottom = min(2048, int(np.ceil((rows[-1] + 5) / h * 2048 / 4) * 4))
    return top / 2048, bottom / 2048


def webp(img: np.ndarray, path: Path) -> int:
    Image.fromarray(img).save(path, 'WEBP', quality=WEBP_Q, method=6)
    return path.stat().st_size


def run(venue: str, layers_root: Path) -> dict:
    src = layers_root / venue
    d_bg = np.load(src / 'bg_distance.npy')
    d_fg = np.load(src / 'fg_distance.npy')
    counts = {}
    for name, (v, t) in (('bg', bg_mesh(venue)), ('fg', fg_mesh(smooth_furniture(d_fg, d_bg)))):
        for part, (pv, pt) in zip(('lo', 'hi'), split_at_lens(v, t)):
            np.save(src / f'mesh-{name}-{part}-pos.npy', pv.astype(np.float32))
            np.save(src / f'mesh-{name}-{part}-idx.npy', pt.astype(np.uint32))
            counts[f'{name}-{part}'] = int(len(pt))

    bg4 = np.array(Image.open(src / 'bg-4k.png').convert('RGB'))
    orig4 = np.array(Image.open(OUT / f'{venue}-4k.webp').convert('RGB'))
    v0, v1 = fg_rows(d_fg)
    r0, r1 = int(round(v0 * 2048)), int(round(v1 * 2048))
    crop = orig4[r0:r1]
    sizes = {
        'bg': webp(bg4, OUT / f'{venue}-bg-4k.webp'),
        'bgLow': webp(cv2.resize(bg4, (2048, 1024), interpolation=cv2.INTER_AREA), OUT / f'{venue}-bg-2k.webp'),
        'fg': webp(crop, OUT / f'{venue}-fg-4k.webp'),
        'fgLow': webp(cv2.resize(crop, (2048, (r1 - r0) // 2), interpolation=cv2.INTER_AREA), OUT / f'{venue}-fg-2k.webp'),
    }
    info = dict(venue=venue, fgRows=[v0, v1], bytes=sizes, tris=counts)
    (src / 'pack.json').write_text(json.dumps(info, indent=2))
    print(json.dumps(info))
    return info


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--layers', default=str(ROOT / 'scratch' / 'venues-layers'))
    args = ap.parse_args()
    for v in args.only.split(',') if args.only else list(ROOMS):
        run(v, Path(args.layers))


if __name__ == '__main__':
    main()
