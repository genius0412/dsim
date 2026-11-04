import type { ArtifactColor } from '../../types';

/* THE 2D ELEMENT INKS, in a module of their own so `drawField.ts` can draw the holding box's NECTAR
 * in them: `draw.ts` imports `drawField.ts` (the hive canopy), so `drawField.ts` importing them from
 * `draw.ts` would close a cycle. `draw.ts` re-exports all three. */

/** Fixed rather than themed: the mat token already flips between light and dark, and an
 * element that also flipped would be a light ball on a light field half the time. The rim is
 * shared — one dark outline reads against the mat in both themes and against all three
 * fills. */
export const ELEMENT_LINE = 'rgba(28,22,6,0.6)';
/**
 * OWNER BUG 12 (2026-09-19): "the blue alliance looks too purple — are you sure that is the
 * exact colour AndyMark uses?" Measured, the complaint is right and BOTH answers the repo had
 * were wrong. In OKLCH: the old `#4d8fe2`/`#0a5cff`/`C.COLORS.blue` family sits at hue 255-262°,
 * and the field CAD's own hive Goal Ribs are `plastic#0000ff` — hue 264.1°, which is 1.7° off the
 * most violet blue sRGB can express and the WORST answer available. A STEP assembly carrying
 * pure `#ff0000` and pure `#0000ff` is carrying PLACEHOLDER part colours, not a paint spec, and
 * `renderFieldGlb.ts` already overrides the same file's `#e6e6e6` "white plastic" placeholder for
 * exactly that reason. No authoritative AndyMark blue was found, so this is not one.
 *
 * `#007be1` is a PERCEPTUAL CORRECTION and APPROX: hue 252.9°, which is the least violet a
 * saturated blue gets before it starts reading cyan, at the maximum chroma sRGB has there
 * (0.179) and L 0.583 — within 0.002 of the red tape's own lightness, so the two alliances read
 * at the same weight. It is 11.2° off the CAD's rib colour, and that gap is deliberate.
 *
 * ⚠️ ONE BIOBUZZ BLUE. Tape, NECTAR, hive accents, the constants-built fallback scene, the GLB's
 * ribs and the robot silhouette all take this value; there is no second approximation left.
 */
export const BB_ALLIANCE_BLUE = '#007be1';

export const ELEMENT_FILL: Record<ArtifactColor, string> = {
  yellow: '#f2d14b', // POLLEN
  red: '#e2564d', // red NECTAR
  blue: BB_ALLIANCE_BLUE, // blue NECTAR
  // DECODE's two, unreachable in a BIOBUZZ world but the record has to be total
  purple: '#9b6bd6',
  green: '#59c08a',
};
