"""
THE PHOTOGRAPHED VENUES AS TWO LAYERS — stage 2, after `depth.py`.

A panorama projected onto a box draws everything that is not floor or wall where its ray meets the
box, so from any eye but the lens a chair is a streak across the floor. This splits each venue into:

  BACKGROUND  the room with its furniture removed: depth from MoGe with every object's pixels
              filled from the surfaces behind it (the floor under a chair is the floor), the floor
              and walls snapped to the measured room where they are within a few inches of it, and
              the colour inpainted (LaMa) where the furniture was.
  FOREGROUND  the furniture alone, at MoGe's depth: OneFormer (ADE20K) says which pixels are not
              room structure, and the geometry gates below keep only what stands on the floor away
              from the field.

Writes under `--out` (default `scratch/venues-layers/<id>/`):
  bg_distance.npy, fg_distance.npy (0 where there is no foreground), fg_mask.png,
  bg.png (the inpainted panorama at the depth resolution), meta.json
and the textures into `public/venues/` (see `mesh.mjs` for the meshes).

  python scripts/venues/layers.py [--only school-hall]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_fill_holes, label
from scipy.sparse import csr_matrix
from scipy.sparse.linalg import spsolve

from depth import moge_directions, renderer_directions

# torch, utils3d and moge are imported where they are used, so `meshes.py` (which takes the room
# from here) runs on a CPU-only box with numpy, opencv, scipy and pillow

ROOT = Path(__file__).resolve().parents[2]

# `PHOTO_FLOOR_Z` in `renderPhotoVenue.ts`
FLOOR_Z = -0.75
# each venue's lens above its floor, inches: `PhotoVenue.height` in `environments.ts`, MEASURED per
# venue off its own photograph (`PHOTO_LENS_IN`'s note there). A re-measured lens rescales ROOMS and
# FLOOR_STEPS about the lens (`rescale-lens.ts` does the room file the same way)
LENS = {'school-hall': 63.0, 'events-hall': 63.0, 'hangar': 63.0, 'court': 64.6, 'quad': 63.0}


def eye(venue: str) -> np.ndarray:
    """the lens: above the field's centre, its venue's lens height above the floor"""
    return np.array([0.0, 0.0, FLOOR_Z + LENS[venue]], np.float32)


# `PhotoVenue.room` in `environments.ts`; meta.json repeats it, `sync-env.mjs` writes it back into the
# row, and the RENDER lane compares the row with the room file. `ceil` is the HIGHEST ceiling (what
# the box fallback and the cameras use); a room with `eave` has a GABLE roof instead of a flat one:
# `eave` high at the side walls (y0, y1), rising in two flat slopes to `ceil` along the ridge, a line
# parallel to x at y = `ridgeY` (`room_distance`).
ROOMS = {
    'school-hall': dict(x0=-233, x1=246, y0=-208, y1=551, ceil=260),
    # PENDING REBUILD (2026-10-24): gable roof. Eave 145: the +y wall's top along x −60…+120 (an
    # edge trace, 145–151) and the earlier read of 140–150. Ridge 250: the end walls' gable peaks,
    # −x 220 at y ≈ −60 (a clean edge trace of the brick against the roof, x0 off its floor line)
    # and +x 255–280 at y ≈ +100 (by eye, el 18.0° at az 9°); ridgeY 20 is their mean. NOT the
    # 400–430 an earlier read gave: the peaks are 14.5° and 18° up, and a 17° pitch is what the
    # photograph shows. The two peaks' y say the ridge runs ~7° off x, and the side walls' tops
    # slope the same way in a wall-square crop (~5°): the hall is turned ~5–6° against its box
    # (`yaw` −20 in `venues.cjs` would be ~−26). Not fixed here: the derive patch is in that frame
    # and its room is the row's (the RENDER lane) — a follow-up with its own re-measure. The walls
    # are as before (the floor lines put x0 nearer −663 and x1 ~650; same follow-up).
    'events-hall': dict(x0=-611, x1=668, y0=-318, y1=365, ceil=250, eave=145, ridgeY=20),
    # PENDING REBUILD (2026-10-24): TURNED 18° (`yaw` 72 in `venues.cjs`, was 90) and re-measured
    # in that frame, in lens heights (H = 63 in). In the old files every long line ran at ~+18°:
    # both side walls (17.6°, 18.6°), the open door's centre (18.5°), the roof's spine (18°); turned,
    # the end walls' floor lines are level in a wall-square crop. Side walls ±6.9 H (±435): the +y
    # curtains' feet 6.7–6.9 H, the −y pallet stacks' feet 6.85–6.98 H, and the two walls' window
    # sill-to-head spans subtend the same angle within 0.4 % (tan-el span 0.2885 / 0.2875), so the
    # lens is on the centre line — an earlier read of 12.3 H apart, 0.76 off-centre, was the clutter
    # along the walls. x1 13.6 H (857): the open door's leaves, feet at 13.4–13.8 H. x0 −11.25 H
    # (−709): the end wall's two side bays, feet at −11.0…−11.5 H; its middle bay (|y| ≲ 3.5 H,
    # behind the aircraft) is recessed to −14.5 H, which a box cannot hold (future work). The roof
    # is a shallow ARCH, held as a gable: eave 5.2 H (328, the wall-top beam, tan el / sin = 0.631
    # and 0.594 over 6.9 H), crown 7.67 H (483, where the roof meets the door wall, el 26.1° over
    # 13.6 H; the door's head is 5.19 H). A flat 410 was 1.2 H off at both.
    'hangar': dict(x0=-709, x1=857, y0=-435, y1=435, ceil=483, eave=328, ridgeY=0),
    'court': dict(x0=-736, x1=801, y0=-394, y1=374, ceil=2051),
    'quad': dict(x0=-630, x1=662, y0=-372, y1=384, ceil=190),
}
# the field and its walls with room to spare: nothing in the photograph stands there (the lens
# stood at its centre), and a foreground object there would stand inside the field
FIELD_KEEP_OUT = 90.0
# a venue whose floor is not one level: beyond the `edge` polyline (field inches, (x, y) points with
# x rising; y between them by straight lines, the end values past the ends) it is `z`. The school
# hall's field stands on a stage over an auditorium, where the box drew the whole auditorium at stage
# level and 0.6 x as deep.
#   z (PENDING REBUILD, 2026-10-24; was −25.3, MoGe's depth of the auditorium's flat run): the front
#   rows' chairs, seat 0.45 m, seat-front over foot on six chairs at foot el 27.9–29.8°, put the lens
#   2.49–2.88 m above the auditorium floor (mean 2.71, so 106.7 in): 44 in below the stage.
#   edge (PENDING REBUILD; was a straight y0 = 80): the stage lip off a top-down projection at stage
#   level, in lens heights × 63: the −x thrust's front at y 120 to x −148, a diagonal to (−32, 91),
#   the centre (−25, 78) (0, 81) (38, 72) (57, 60), the stair foot (126, 50), then the +x thrust's
#   front (137, 93) (189, 124) to the wall. Kept at 80 between x −25 and 134 where it measures
#   nearer: the field's own wall stands at 72–76, and the floor round it must be the stage.
# `PhotoLayers.floor` in `environments.ts` is the stage's rectangle for the shadow catcher, y1 the
# edge's lowest y (`sync-env.mjs` writes it).
FLOOR_STEPS = {
    'school-hall': dict(
        edge=[(-233, 120), (-148, 120), (-32, 91), (-25, 80), (134, 80), (137, 93), (189, 124), (246, 124)],
        z=-44.0,
    ),
}

# ADE20K classes that are the room's SHELL: what `PhotoVenue.room` (the box) measures, so the depth is
# corrected toward the box on them (`shell_correction`)
SHELL = {'wall', 'floor', 'ceiling', 'building', 'road', 'sidewalk', 'earth', 'grass', 'field', 'ground', 'land', 'fence'}

# ADE20K classes that are the ROOM, not things in it. Everything else in a venue is furniture.
STRUCTURE = {
    'wall', 'building', 'sky', 'floor', 'ceiling', 'road', 'windowpane', 'grass', 'sidewalk', 'earth',
    'door', 'mountain', 'curtain', 'house', 'rug', 'field', 'fence', 'path', 'stairs', 'runway',
    'screen door', 'stairway', 'blind', 'hill', 'dirt track', 'land', 'stage', 'step', 'skyscraper',
    'tower', 'tree', 'water', 'sea', 'river', 'lake', 'sand', 'canopy', 'awning', 'bridge', 'palm',
    'plant', 'flower', 'railing', 'bannister', 'escalator', 'swimming pool', 'waterfall',
}


def project_views_to_panorama(h: int, w: int, maps: list[np.ndarray], exts, intrs) -> np.ndarray:
    """each view's scalar map onto the panorama, weighted toward each view's centre"""
    import utils3d

    dirs = moge_directions(h, w)
    acc = np.zeros((h, w), np.float32)
    wsum = np.zeros((h, w), np.float32)
    for m, ext, intr in zip(maps, exts, intrs):
        uv, depth = utils3d.np.project_cv(dirs, extrinsics=ext, intrinsics=intr)
        valid = (depth > 0) & (uv > 0).all(-1) & (uv < 1).all(-1)
        px = utils3d.np.uv_to_pixel(np.clip(uv, 0, 1), m.shape[:2]).astype(np.float32)
        mv = cv2.remap(m.astype(np.float32), px[..., 0], px[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        cw = np.clip(1 - 2 * np.max(np.abs(uv - 0.5), axis=-1), 0, 1)
        wgt = np.where(valid, cw, 0).astype(np.float32)
        acc += mv * wgt
        wsum += wgt
    return acc / np.clip(wsum, 1e-6, None)


def structure_probability(image: np.ndarray, h: int, w: int, device) -> tuple[np.ndarray, np.ndarray]:
    """OneFormer (shi-labs/oneformer_ade20k_swin_large, MIT) on twelve 90-degree views: the share of
    each pixel's class score that is room structure, and the share that is the room's shell"""
    import torch
    from moge.utils.panorama import get_panorama_cameras, split_panorama_image
    from transformers import OneFormerForUniversalSegmentation, OneFormerProcessor

    name = 'shi-labs/oneformer_ade20k_swin_large'
    processor = OneFormerProcessor.from_pretrained(name)
    model = OneFormerForUniversalSegmentation.from_pretrained(name).to(device).eval()
    labels = model.config.id2label
    first = lambda n: n.split(',')[0].strip()
    struct_ids = [int(i) for i, n in labels.items() if first(n) in STRUCTURE]
    shell_ids = [int(i) for i, n in labels.items() if first(n) in SHELL]
    exts, intrs = get_panorama_cameras()
    res = 768
    views = split_panorama_image(image, exts, intrs, res)
    probs, shells = [], []
    for v in views:
        inputs = processor(images=Image.fromarray(v), task_inputs=['semantic'], return_tensors='pt').to(device)
        with torch.inference_mode():
            out = model(**inputs)
        cls = out.class_queries_logits.softmax(-1)[0, :, :-1]  # Q x C
        msk = out.masks_queries_logits.sigmoid()[0]  # Q x h x w
        seg = torch.einsum('qc,qhw->chw', cls, msk)
        seg = torch.nn.functional.interpolate(seg[None], size=(res, res), mode='bilinear', align_corners=False)[0]
        seg = seg / seg.sum(0, keepdim=True).clamp_min(1e-6)
        probs.append(seg[struct_ids].sum(0).cpu().numpy())
        shells.append(seg[shell_ids].sum(0).cpu().numpy())
    return project_views_to_panorama(h, w, probs, exts, intrs), project_views_to_panorama(h, w, shells, exts, intrs)


def shell_correction(dist: np.ndarray, d_box: np.ndarray, p_shell: np.ndarray) -> np.ndarray:
    """a smooth multiplier on MoGe's distance that brings the room's shell onto the measured box.
    MoGe's scale is fitted on the floor near the field (`run`) and reads the far walls 6-15 % deep; a
    per-pixel snap to the box where it came within a tolerance left snapped and unsnapped patches of
    one wall at different depths, each step a stretched sheet. This is the ratio box / MoGe on shell
    pixels that agree within 30 %, filled across everything else and blurred over ~10 degrees, so it
    bends the whole picture smoothly and keeps every depth MoGe saw relative to its neighbours."""
    h, w = dist.shape
    gh, gw = 128, 256
    ratio = np.log(d_box / dist)
    use = (p_shell > 0.6) & (np.abs(ratio) < np.log(1.3)) & np.isfinite(ratio)
    num = cv2.resize(np.where(use, ratio, 0).astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA)
    den = cv2.resize(use.astype(np.float32), (gw, gh), interpolation=cv2.INTER_AREA)
    known = den > 0.05
    vals = np.where(known, num / np.maximum(den, 1e-6), 0)
    filled = harmonic_fill(vals, known, ~known, fallback=0.0)
    # blur with the u wrap
    pad = 16
    wrapped = np.concatenate([filled[:, -pad:], filled, filled[:, :pad]], axis=1)
    blurred = cv2.GaussianBlur(wrapped.astype(np.float32), (0, 0), 3.5)[:, pad:-pad]
    return np.exp(cv2.resize(blurred, (w, h), interpolation=cv2.INTER_CUBIC)).astype(np.float32)


def harmonic_fill(values: np.ndarray, known: np.ndarray, region: np.ndarray, fallback: float | None = None) -> np.ndarray:
    """Laplace fill of `values` inside `region` from the `known` pixels around it (wrapping in u).
    A part of `region` that touches nothing known is pulled weakly toward `fallback` (default: the
    known pixels' median) instead of being left singular."""
    h, w = values.shape
    out = values.astype(np.float64).copy()
    ys, xs = np.nonzero(region)
    n = len(ys)
    if n == 0:
        return out
    idx = -np.ones((h, w), np.int64)
    idx[ys, xs] = np.arange(n)
    if fallback is None:
        fallback = float(np.median(values[known])) if known.any() else 0.0
    rows, cols = [], []
    diag = np.zeros(n)
    b = np.zeros(n)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        yy = ys + dy
        xx = (xs + dx) % w
        ok = (yy >= 0) & (yy < h)
        yc = np.clip(yy, 0, h - 1)
        j = idx[yc, xx]
        inreg = ok & (j >= 0)
        kn = ok & (j < 0) & known[yc, xx]
        diag += inreg | kn
        rows.append(np.nonzero(inreg)[0])
        cols.append(j[inreg])
        b[kn] += values[yc[kn], xx[kn]]
    eps = 1e-4
    diag += eps
    b += eps * fallback
    r = np.concatenate(rows + [np.arange(n)])
    c = np.concatenate(cols + [np.arange(n)])
    v = np.concatenate([-np.ones(len(x)) for x in rows] + [diag])
    out[ys, xs] = spsolve(csr_matrix((v, (r, c)), shape=(n, n)), b)
    return out


def room_distance(dirs: np.ndarray, room: dict, step: dict | None, eye: np.ndarray) -> np.ndarray:
    """distance from the lens along each ray to the MEASURED ROOM: the box, its floor dropped to
    `step['z']` beyond the `step['edge']` polyline where the venue has a step (`FLOOR_STEPS`), and its
    walls running down to that floor; its ceiling flat at `ceil`, or a gable where the room has an
    `eave` (`ROOMS`). The lens is above the upper floor, so the step's own face is never seen."""
    with np.errstate(divide='ignore', invalid='ignore'):
        tx = np.where(dirs[..., 0] > 0, (room['x1'] - eye[0]) / dirs[..., 0], (room['x0'] - eye[0]) / dirs[..., 0])
        ty = np.where(dirs[..., 1] > 0, (room['y1'] - eye[1]) / dirs[..., 1], (room['y0'] - eye[1]) / dirs[..., 1])
        tc = (FLOOR_Z + room['ceil'] - eye[2]) / dirs[..., 2]
        if 'eave' in room:
            # the roof is the lower of two planes z = FLOOR_Z + ceil − m (y − ridgeY), one through
            # each side wall's eave line (m = (ceil − eave) / (wall − ridgeY)). The lens is below
            # both, so a ray meets the roof where it first crosses either.
            tc = np.inf
            for wall in (room['y0'], room['y1']):
                m = (room['ceil'] - room['eave']) / (wall - room['ridgeY'])
                t = (FLOOR_Z + room['ceil'] - m * (eye[1] - room['ridgeY']) - eye[2]) / (dirs[..., 2] + m * dirs[..., 1])
                tc = np.minimum(tc, np.where(t > 0, t, np.inf))
        tf = (FLOOR_Z - eye[2]) / dirs[..., 2]
        if step is not None:
            ex, ey = np.array(step['edge'], np.float64).T
            beyond = eye[1] + tf * dirs[..., 1] >= np.interp(eye[0] + tf * dirs[..., 0], ex, ey)
            tf = np.where(beyond, (step['z'] - eye[2]) / dirs[..., 2], tf)
    tz = np.where(dirs[..., 2] > 0, tc, tf)
    t = np.stack([tx, ty, tz], -1)
    t = np.where(np.isfinite(t) & (t > 0), t, np.inf)
    return np.min(t, axis=-1).astype(np.float32)


def run(venue: str, depth_root: Path, out_root: Path, device, lama) -> None:
    room = ROOMS[venue]
    lens = LENS[venue]
    e = eye(venue)
    src = ROOT / 'public' / 'venues' / f'{venue}-4k.webp'
    image4 = np.array(Image.open(src).convert('RGB'))
    raw = np.load(depth_root / venue / 'distance.npy')
    nrm = np.load(depth_root / venue / 'normal.npy')
    h, w = raw.shape
    image = cv2.resize(image4, (w, h), interpolation=cv2.INTER_AREA)
    dirs = renderer_directions(h, w)

    # ---- the scale: the floor near the field is the lens height below the lens ----
    dep = -dirs[..., 2]
    expected = lens / np.clip(dep, 1e-6, None)
    near_floor = (nrm[..., 2] > 0.95) & (dep > np.sin(np.radians(30))) & (dep < np.sin(np.radians(80)))
    ratio = expected[near_floor] / raw[near_floor]
    scale = float(np.median(ratio))
    dist = raw * scale
    d_room = room_distance(dirs, room, FLOOR_STEPS.get(venue), e)

    # ---- what is furniture, and the shell the depth is bent onto ----
    p_struct, p_shell = structure_probability(image, h, w, device)
    corr = shell_correction(dist, d_room, p_shell)
    dist = dist * corr
    pts = e + dirs * dist[..., None]
    in_field = (np.abs(pts[..., 0]) < FIELD_KEEP_OUT) & (np.abs(pts[..., 1]) < FIELD_KEEP_OUT)
    below_ceiling = pts[..., 2] < FLOOR_Z + room['ceil'] - 12
    # by class, and anything else the classes call room that stands well clear in front of the
    # shell below the lens (a rail, a rack): left in the room it would be a sheet stretched from its
    # edge to the wall behind. Not higher: the sky, a far treeline and a curved roof all read nearer
    # than the box and are the room.
    in_front = (dist < d_room * 0.85) & (p_shell < 0.5) & (pts[..., 2] < FLOOR_Z + 60)
    fg = ((p_struct < 0.6) | in_front) & ~in_field & below_ceiling & (dist > 24)
    # drop specks (an object is at least a hundred-odd pixels at this resolution); no opening, which
    # took the piano's legs and the front row's chair legs off
    lab, n = label(fg)
    if n:
        sizes = np.bincount(lab.ravel())
        keep = sizes >= 150
        keep[0] = False
        fg = keep[lab]
    fg = binary_fill_holes(fg) & ~in_field
    # the mask the background is filled under: a few pixels wider, so no object's edge colour is
    # left on the room
    wide = binary_dilation(fg, iterations=3) & ~in_field

    fg_seed = fg
    fg = wide

    # ---- the room behind the furniture IS the measured room (`room_distance`): the box, with the
    # floor step a venue has. MoGe's own room was tried first and lost: its walls are a few per cent
    # of noise, a closed mesh bridges every jump in its depth with a sheet that is a smear seen from
    # off the lens (the events hall's brick wall tops against its roof drew a band of blur the height
    # of the wall), a blur that hid the jumps turned every floor/wall junction into a ramp, and the
    # school hall's auditorium came out as a warped funnel. The box never smeared the room; it
    # smeared the furniture, which is now its own layer. ----
    d_bg = d_room.astype(np.float32)

    # the furniture itself: in the wide mask AND standing clear of the room behind it. The ring the
    # dilation added is the room, at the room's depth, and is left to it. What the classes are sure
    # is furniture (a chair, a table, a piano) needs only stand 3 % clear: the back rows of the school
    # hall's seats are that close to its wall. Anything less sure needs ~10 %, and below that draws
    # right painted on the wall and wrong as a relief a hand's width off it (the school hall's
    # doorway, half taken for an object, floated off its wall as a white band). Specks are dropped.
    obj = fg & (((dist < d_bg * 0.97) & (p_struct < 0.3)) | (dist < d_bg * 0.9))
    lab, n = label(obj)
    if n:
        sizes = np.bincount(lab.ravel())
        keep = sizes >= 300
        keep[0] = False
        obj = keep[lab]
    d_fg = np.where(obj, dist, 0).astype(np.float32)

    # ---- the colour behind the furniture: what the furniture layer draws, and everything else the
    # classes are sure is furniture, painted out a few pixels wide. The sure-but-not-drawn (the
    # school hall's back rows, within 3 % of its wall) must go too: left in, they were the context
    # LaMa copied into every gap between the drawn rows, and the floor behind the seats came out
    # tiled with ghost chairs that streaked from the Home shot exactly as the old smear did ----
    inpaint_mask = binary_dilation(obj | (fg_seed & (p_struct < 0.3)), iterations=3) & ~in_field
    pad = w // 8
    img_p = np.concatenate([image[:, -pad:], image, image[:, :pad]], axis=1)
    msk_p = np.concatenate([inpaint_mask[:, -pad:], inpaint_mask, inpaint_mask[:, :pad]], axis=1)
    filled = np.array(lama(Image.fromarray(img_p), Image.fromarray((msk_p * 255).astype(np.uint8)).convert('L')))
    filled = filled[: h, pad : pad + w]
    bg_img = np.where(inpaint_mask[..., None], filled, image).astype(np.uint8)

    out = out_root / venue
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / 'bg_distance.npy', d_bg.astype(np.float32))
    np.save(out / 'fg_distance.npy', d_fg)
    cv2.imwrite(str(out / 'fg_mask.png'), (obj * 255).astype(np.uint8))
    cv2.imwrite(str(out / 'p_struct.png'), (np.clip(p_struct, 0, 1) * 255).astype(np.uint8))
    Image.fromarray(bg_img).save(out / 'bg.png')
    # the 4k inpainted backdrop: the original everywhere but the (upscaled) furniture mask
    m4 = cv2.resize(inpaint_mask.astype(np.uint8), (image4.shape[1], image4.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    m4 = binary_dilation(m4, iterations=2)
    f4 = cv2.resize(filled, (image4.shape[1], image4.shape[0]), interpolation=cv2.INTER_CUBIC)
    bg4 = np.where(m4[..., None], f4, image4).astype(np.uint8)
    Image.fromarray(bg4).save(out / 'bg-4k.png')
    meta = dict(venue=venue, scale=scale, room=room, lens=lens, floorZ=FLOOR_Z, width=w, height=h,
                fgPixels=int(obj.sum()), shellCorrection=[float(corr.min()), float(np.median(corr)), float(corr.max())],
                floorStep=FLOOR_STEPS.get(venue))
    (out / 'meta.json').write_text(json.dumps(meta, indent=2))
    print(venue, 'scale', round(scale, 2), 'fg px', int(obj.sum()), 'seed', int(fg_seed.sum()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--depth', default=str(ROOT / 'scratch' / 'venues-depth'))
    ap.add_argument('--out', default=str(ROOT / 'scratch' / 'venues-layers'))
    args = ap.parse_args()
    import torch
    from simple_lama_inpainting import SimpleLama

    device = torch.device('cuda')
    lama = SimpleLama(device)
    for v in args.only.split(',') if args.only else list(ROOMS):
        run(v, Path(args.depth), Path(args.out), device, lama)


if __name__ == '__main__':
    main()
