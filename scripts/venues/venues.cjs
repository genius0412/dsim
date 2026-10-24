// THE PHOTOGRAPHED VENUES `derive.cjs` builds — one row per backdrop under `public/venues/`.
//
// Source: Poly Haven's 4k `.hdr` of each asset (CC0 1.0). `md5` is the API's own for that file
// (https://api.polyhaven.com/files/<slug>), checked before anything is derived, so a re-run cannot
// quietly build from a different photograph. `authors` is the API's `authors` map, role and all.
//
// The runtime projection (capture height, room box) is NOT here: it is a rendering decision and
// lives with the rest of the environment row in `src/games/biobuzz/graphics/environments.ts`.
// What is here changes the FILES:
//   yaw     degrees the panorama is turned before it is written (a whole-column shift, exact), so
//           the room's walls line up with the field's x/y axes. Baked into the backdrop AND the
//           light-gathering `.hdr`, so the two agree by construction.
//   gain    the linear scale applied before the highlight curve (see `derive.cjs`, ENCODING).
//           Chosen so the floor's median lands near 0.25, the middle of the 8-bit code range.
//   quality WebP quality, 0–1, for the 4096 and 2048 backdrops.
//   patches regions refilled from the room's mirror image, for furniture a floor projection
//           would smear (derive.cjs, THE FURNITURE PATCH). Optional.
//   degloss a glossy floor's window reflections flattened (derive.cjs, THE FLOOR DE-GLOSS). Optional.
'use strict';

module.exports = [
  {
    id: 'school-hall',
    slug: 'school_hall',
    md5: 'aa26139e09ebc81137abb429bc31a39c',
    authors: { 'Dimitrios Savva': 'Photography', 'Jarod Guest': 'Processing' },
    yaw: 180,
    gain: 1.3,
    quality: 0.9,
    // the lectern at the stage's front edge (blue, an alliance colour, and drawn flat across the
    // floor beside the field): filled from the front row 22° round; and the projector on the
    // stage floor just past the field's +x+y corner, from the bare boards 16° round
    patches: [
      { th: [90, 109], e: [-41, -17], feather: 2, shift: -22 },
      { th: [46, 63], e: [-47, -34], feather: 2, shift: 17 },
    ],
  },
  {
    id: 'events-hall',
    slug: 'events_hall_interior',
    md5: '1b03b3cba4a059c2a59cbce336fe08c3',
    authors: { 'Dimitrios Savva': 'Photography', 'Jarod Guest': 'Processing' },
    yaw: -20,
    gain: 1.0,
    quality: 0.9,
    // the banquet table and its ~40 chairs, 2–5 lens heights out on +y: filled from the room's
    // mirror image (derive.cjs, THE FURNITURE PATCH). `room` is the environment row's
    // `photo.room` over its `height` (63 in).
    patches: [{ th: [26, 170], e: [-62, -3.5], feather: 3, room: { x0: -9.7, x1: 10.6, y0: -5.05, y1: 5.8, ceil: 4.76 } }],
    // the polished concrete's window reflections (derive.cjs, THE FLOOR DE-GLOSS)
    degloss: { e: [-80, -4], blur: 3, above: 1.05, strength: 1, pct: 0.3 },
  },
  {
    id: 'hangar',
    slug: 'small_hangar_01',
    md5: '14ec4d5609dd2e8a1f847ae9a4a54a32',
    authors: { 'Sergej Majboroda': 'All' },
    // PENDING REBUILD (2026-10-24): was 90, which left every long line of the shed at ~+18° in the
    // field frame (side walls 17.6° and 18.6°, the open door's centre 18.5°, the roof's spine 18°).
    // The shipped hangar files are still the 90 turn until `scripts/venues/GPU-REBUILD.md` is done.
    yaw: 72,
    gain: 1.5,
    quality: 0.9,
  },
  {
    id: 'court',
    slug: 'netball_court',
    md5: '537240c4f74f5d7eefa4e3af81c22a51',
    authors: { 'Dimitrios Savva': 'Photography', 'Jarod Guest': 'Processing' },
    yaw: -55,
    gain: 2.5,
    quality: 0.9,
  },
  {
    id: 'quad',
    slug: 'school_quad',
    md5: 'ddecfc04a5f94a3a6834883fe47492e0',
    authors: { 'Dimitrios Savva': 'Photography', 'Jarod Guest': 'Processing' },
    yaw: 0,
    gain: 1.1,
    quality: 0.9,
  },
];
