"""
THE FLOOR TILES — a photographed venue's floor as a sharp repeating texture (2026-11-01).

The panorama sees its floor from the lens, 63 in up, so a few lens heights out each texel is a long
strip pointing at the lens, and any camera higher or nearer than the lens draws those strips as
streaks (`src/games/biobuzz/scene/renderPhotoVenue.ts`, THE FLOOR). Beside the lens the same floor
is sharp: 0.2–0.5 in a texel within 100 in. This cuts a tile from there:

  1. the floor seen straight down (every floor point looks up the panorama along the ray from the
     lens, as the renderer does), turned by the lens's own small TILT where the photograph is not
     level (the school hall's planks converged by ~8° across 12 ft without it), and by a TURN that
     puts the planks or the paving joints along the tile's edges;
  2. its light divided out (a Gaussian of 12 % of the tile, on a mirrored extension): what is left
     is texture, and the renderer puts the room's light back from the photograph, blurred;
  3. its edges made to repeat by blending with a half-turn copy near the edges, keeping the
     variance. A floor with joints is cut to a whole EVEN number of them across, so the copy's
     joints land on the tile's own and the blend draws no doubled seams.

Writes public/venues/<id>-floor.webp (1024 × 1024, the backdrop's own encoding: sRGB 8-bit of
e = v / (1 + v), so the shader decodes it with the backdrop's curve) and prints each row's
`floorTexture` numbers for `environments.ts`. Runs on the derived `<id>-bg-4k.webp`, so rerun it
after `meshes.py`. Needs only numpy and Pillow.

  python scripts/venues/floor.py [--only hangar,quad]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
VENUES = ROOT / 'public' / 'venues'
LENS_IN = 63.0
PX = 1024

# where each tile is cut, field inches from the lens's foot. `tilt` (about x, about y, degrees) is
# the lens's own, found by eye from the rectified floor; `joints` asks for the turn and the period
# along y ('y': planks) or both axes ('xy': pavers), searched over `period` inches.
TILES = {
    'hangar': dict(cx=0, cy=0, size=240),
    'school-hall': dict(cx=0, cy=-60, size=140, tilt=(0.8, -3.4), joints='y', period=(3.5, 8.0)),
    'quad': dict(cx=0, cy=0, size=150, tilt=(2.1, 0.8), joints='xy', period=(10.0, 30.0)),
}
# a row whose own floor is painted over (the events hall's: its furniture was refilled from the
# room's mirror image, and its window reflections flattened) takes another's tile, recoloured
USES = {'events-hall': 'hangar', 'hangar': 'hangar', 'school-hall': 'school-hall', 'quad': 'quad'}


def load(vid: str) -> np.ndarray:
    return np.asarray(Image.open(VENUES / f'{vid}-bg-4k.webp').convert('RGB'), dtype=np.float32) / 255.0


def sample(pan: np.ndarray, dx, dy, dz) -> np.ndarray:
    """bilinear lookup along world directions — the renderer's (`photoUv`)"""
    h, w, _ = pan.shape
    n = np.sqrt(dx * dx + dy * dy + dz * dz)
    x = (np.arctan2(-dy / n, dx / n) / (2 * np.pi) + 0.5) * w - 0.5
    y = (0.5 - np.arcsin(np.clip(dz / n, -1, 1)) / np.pi) * h - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x1 = (x0 + 1) % w
    x0 = x0 % w
    ya = np.clip(y0, 0, h - 1)
    yb = np.clip(y0 + 1, 0, h - 1)
    return (pan[ya, x0] * (1 - fx) + pan[ya, x1] * fx) * (1 - fy) + (pan[yb, x0] * (1 - fx) + pan[yb, x1] * fx) * fy


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def decode(c):
    """the backdrop's stored value → the renderer's `e / (1 − e)` (before `gain` and `intensity`)"""
    e = np.minimum(srgb_to_lin(c), 0.996)
    return e / (1 - e)


def encode(v):
    return lin_to_srgb(v / (1 + v))


def ortho(pan, cx, cy, sx, sy, px, turn=0.0, tilt=(0.0, 0.0)):
    """the floor straight down: px × px over sx × sy inches round (cx, cy), turned by `turn`, row 0
    at −y (the shader reads v = y / inches)"""
    t = (np.arange(px) + 0.5) / px - 0.5
    u, v = np.meshgrid(t * sx, t * sy)
    c, s = np.cos(np.radians(turn)), np.sin(np.radians(turn))
    x = cx + u * c - v * s
    y = cy + u * s + v * c
    z = np.full_like(x, -LENS_IN)
    a, b = np.radians(tilt[0]), np.radians(tilt[1])
    y, z = y * np.cos(a) - z * np.sin(a), y * np.sin(a) + z * np.cos(a)
    x, z = x * np.cos(b) + z * np.sin(b), -x * np.sin(b) + z * np.cos(b)
    return sample(pan, x, y, z)


def blur(img, sigma):
    """Gaussian through the FFT (periodic, so callers hand it a mirrored extension)"""
    h, w, _ = img.shape
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (np.fft.rfftfreq(w)[None, :] ** 2 + np.fft.fftfreq(h)[:, None] ** 2))
    return np.stack([np.fft.irfft2(np.fft.rfft2(img[..., k]) * g, s=(h, w)) for k in range(3)], -1)


def flatten(v, sigma):
    n = v.shape[0]
    ext = np.concatenate([v[::-1], v, v[::-1]], 0)
    ext = np.concatenate([ext[:, ::-1], ext, ext[:, ::-1]], 1)
    low = blur(ext, sigma)[n:2 * n, n:2 * n]
    return v / np.maximum(low, 1e-4) * v.reshape(-1, 3).mean(0)


def seamless(v, band):
    n = v.shape[0]
    t = (np.arange(n) + 0.5) / n
    r = np.clip(np.minimum(t, 1 - t) / band, 0, 1)
    r = r * r * (3 - 2 * r)
    w = np.minimum.outer(r, r)[..., None]
    rolled = np.roll(np.roll(v, n // 2, 0), n // 2, 1)
    m = v.reshape(-1, 3).mean(0)
    out = ((v - m) * w + (rolled - m) * (1 - w)) / np.sqrt(w * w + (1 - w) ** 2) + m
    return np.maximum(out, 0)


def joint_turn(pan, t):
    """the turn that puts the joints along the tile's rows (and columns): the row-mean (and
    column-mean) profile of the gradient varies most when each joint falls in one row"""
    def score(turn):
        g = ortho(pan, t['cx'], t['cy'], t['size'] * 0.7, t['size'] * 0.7, 512, turn, t['tilt']).mean(-1)
        gy, gx = np.gradient(g)
        sc = np.var(np.abs(gy).mean(1))
        return sc + (np.var(np.abs(gx).mean(0)) if t['joints'] == 'xy' else 0)
    best = max(np.arange(-45, 45, 1.0), key=score)
    return float(max(np.arange(best - 1, best + 1.01, 0.1), key=score))


def joint_period(img, axis, lo, hi, ipp):
    g = np.abs(np.gradient(img.mean(-1), axis=axis)).mean(axis=1 - axis)
    g = g - g.mean()
    ac = np.correlate(g, g, 'full')[len(g) - 1:]
    lags = np.arange(len(ac)) * ipp
    k = int(np.argmax(np.where((lags >= lo) & (lags <= hi), ac, -np.inf)))
    d = (ac[k - 1] - ac[k + 1]) / (2 * (ac[k - 1] - 2 * ac[k] + ac[k + 1]))
    return (k + d) * ipp


def floor_median(vid, rmin=100, rmax=260):
    """the room's own floor colour, decoded: the median over a ring round the field"""
    a, r = np.meshgrid(np.linspace(0, 2 * np.pi, 720, endpoint=False), np.linspace(rmin, rmax, 40))
    c = sample(load(vid), r * np.cos(a), r * np.sin(a), np.full_like(a, -LENS_IN))
    return np.median(decode(c).reshape(-1, 3), axis=0)


def build(vid):
    t = {'tilt': (0.0, 0.0), **TILES[vid]}
    pan = load(vid)
    turn, sx, sy = 0.0, float(t['size']), float(t['size'])
    if 'joints' in t:
        turn = joint_turn(pan, t)
        probe = ortho(pan, t['cx'], t['cy'], t['size'], t['size'], PX, turn, t['tilt'])
        ipp = t['size'] / PX
        even = lambda p: 2 * p * max(1, round(t['size'] / (2 * p)))  # noqa: E731
        sy = even(joint_period(probe, 0, *t['period'], ipp))
        sx = even(joint_period(probe, 1, *t['period'], ipp)) if t['joints'] == 'xy' else sy
    v = flatten(decode(ortho(pan, t['cx'], t['cy'], sx, sy, PX, turn, t['tilt'])), PX * 0.12)
    v = seamless(v, 0.12 if 'joints' in t else 0.18)
    img = (np.clip(encode(v), 0, 1) * 255 + 0.5).astype(np.uint8)
    out = VENUES / f'{vid}-floor.webp'
    Image.fromarray(img).save(out, quality=90, method=6)
    return {'tile': f'venues/{vid}-floor.webp', 'inches': [round(sx, 2), round(sy, 2)], 'turn': round(turn, 1),
            'mean': [round(float(m), 4) for m in decode(img / 255.0).reshape(-1, 3).mean(0)], 'bytes': out.stat().st_size}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    only = [s for s in ap.parse_args().only.split(',') if s]
    tiles = {vid: build(vid) for vid in TILES if not only or vid in only or any(USES[o] == vid for o in only)}
    for row, src in USES.items():
        if src in tiles and (not only or row in only):
            print(json.dumps({row: {**tiles[src], 'base': [round(float(b), 4) for b in floor_median(row)]}}))


if __name__ == '__main__':
    main()
