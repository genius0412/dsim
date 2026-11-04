import type { PlateFont } from './cosmetics';

/**
 * THE ROBOT SIGN'S NUMBER LAYOUT, and the per-glyph table it reads (`src/plateFonts.ts` has the
 * faces and why the old layout was wrong). Imported by the 3D sign (`scene/renderRobots.ts`, the
 * scene chunk) and by `npm test` only, so the table never rides in the main chunk.
 */

/** one glyph, in em, y up from the baseline: [advance, ink left, ink right, ink bottom, ink top] */
export type PlateGlyph = readonly [number, number, number, number, number];

/** a face's measured numerals: its cap height (OS/2 `sCapHeight`) and its glyphs, em */
export interface PlateMetrics {
  cap: number;
  glyphs: Readonly<Record<string, PlateGlyph>>;
}

/** measured by `scripts/plate-fonts.py` from the subset files themselves — re-run it if a face
 *  changes; the layout is only as right as this table */
export const PLATE_FONT_METRICS: Readonly<Record<PlateFont, PlateMetrics>> = {
  standard: {
    cap: 0.7,
    glyphs: {
      '0': [0.514, 0.03, 0.484, -0.012, 0.71],
      '1': [0.325, 0.018, 0.29, 0.0, 0.7],
      '2': [0.51, 0.027, 0.486, 0.0, 0.708],
      '3': [0.496, 0.022, 0.467, -0.008, 0.7],
      '4': [0.566, 0.019, 0.54, 0.0, 0.7],
      '5': [0.498, 0.03, 0.476, -0.007, 0.7],
      '6': [0.498, 0.029, 0.476, -0.007, 0.708],
      '7': [0.463, 0.012, 0.453, 0.0, 0.7],
      '8': [0.498, 0.026, 0.471, -0.008, 0.714],
      '9': [0.49, 0.015, 0.461, -0.008, 0.707],
      '-': [0.376, 0.023, 0.353, 0.219, 0.361],
    },
  },
  block: {
    cap: 0.688,
    glyphs: {
      '0': [0.667, 0.041, 0.626, -0.012, 0.7],
      '1': [0.667, 0.105, 0.624, 0.0, 0.689],
      '2': [0.667, 0.049, 0.619, 0.0, 0.7],
      '3': [0.667, 0.042, 0.625, -0.012, 0.7],
      '4': [0.667, 0.023, 0.644, 0.0, 0.7],
      '5': [0.667, 0.039, 0.625, -0.012, 0.688],
      '6': [0.667, 0.041, 0.631, -0.012, 0.7],
      '7': [0.667, 0.045, 0.625, 0.0, 0.688],
      '8': [0.667, 0.041, 0.626, -0.012, 0.7],
      '9': [0.667, 0.036, 0.626, -0.012, 0.7],
      '-': [0.333, 0.039, 0.294, 0.196, 0.354],
    },
  },
  racing: {
    cap: 0.688,
    glyphs: {
      '0': [0.66, 0.0481, 0.612, -0.008, 0.696],
      '1': [0.401, 0.0108, 0.3391, 0.0, 0.688],
      '2': [0.613, 0.0478, 0.5635, 0.0, 0.696],
      '3': [0.61, 0.0476, 0.5606, -0.008, 0.696],
      '4': [0.653, 0.0304, 0.6271, 0.0, 0.688],
      '5': [0.627, 0.0654, 0.5794, -0.008, 0.688],
      '6': [0.665, 0.0481, 0.6199, -0.008, 0.696],
      '7': [0.575, 0.0311, 0.5444, 0.0, 0.688],
      '8': [0.679, 0.0466, 0.6325, -0.008, 0.696],
      '9': [0.665, 0.0448, 0.6167, -0.008, 0.696],
      '-': [0.377, 0.0474, 0.3299, 0.2121, 0.3564],
    },
  },
  angular: {
    cap: 0.7,
    glyphs: {
      '0': [0.652, 0.055, 0.597, 0.0, 0.7],
      '1': [0.382, 0.025, 0.312, 0.0, 0.7],
      '2': [0.574, 0.035, 0.539, 0.0, 0.7],
      '3': [0.603, 0.035, 0.553, 0.0, 0.7],
      '4': [0.579, 0.01, 0.569, 0.0, 0.7],
      '5': [0.606, 0.045, 0.561, 0.0, 0.7],
      '6': [0.622, 0.055, 0.577, 0.0, 0.7],
      '7': [0.522, 0.005, 0.497, 0.0, 0.7],
      '8': [0.638, 0.05, 0.588, 0.0, 0.7],
      '9': [0.627, 0.05, 0.572, 0.0, 0.7],
      '-': [0.432, 0.04, 0.392, 0.2, 0.314],
    },
  },
  mono: {
    cap: 0.73,
    glyphs: {
      '0': [0.6, 0.06, 0.54, -0.01, 0.74],
      '1': [0.6, 0.078, 0.56, 0.0, 0.73],
      '2': [0.6, 0.05, 0.542, 0.0, 0.74],
      '3': [0.6, 0.052, 0.54, -0.01, 0.73],
      '4': [0.6, 0.055, 0.525, 0.0, 0.73],
      '5': [0.6, 0.06, 0.54, -0.01, 0.73],
      '6': [0.6, 0.045, 0.555, -0.01, 0.73],
      '7': [0.6, 0.045, 0.55, 0.0, 0.73],
      '8': [0.6, 0.052, 0.548, -0.01, 0.74],
      '9': [0.6, 0.045, 0.555, 0.0, 0.74],
      '-': [0.6, 0.14, 0.46, 0.26, 0.4],
    },
  },
};

/** the ink of `text` in em, y up from the baseline, and the cap height it is sized by. `digits`:
 *  the string has a numeral, so it is centred on the cap band rather than on its own ink. */
export interface PlateInk {
  cap: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  digits: boolean;
}

/** `text`'s ink in `face`, from the measured table. A character the subset does not carry (a sign
 *  only prints digits and `-`, `bbRobotSignText`) is measured as a `0`. */
export function plateInkOf(face: PlateMetrics, text: string): PlateInk {
  let pen = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const ch of text) {
    const g = face.glyphs[ch] ?? face.glyphs['0'];
    x0 = Math.min(x0, pen + g[1]);
    x1 = Math.max(x1, pen + g[2]);
    y0 = Math.min(y0, g[3]);
    y1 = Math.max(y1, g[4]);
    pen += g[0];
  }
  if (!(x1 > x0)) return { cap: face.cap, x0: 0, x1: 0, y0: 0, y1: 0, digits: false };
  return { cap: face.cap, x0, x1, y0, y1, digits: /[0-9]/.test(text) };
}

export interface PlateTextLayout {
  /** the font size: one em, in the box's units */
  size: number;
  /** where `fillText` starts with `textAlign = 'left'` and `textBaseline = 'alphabetic'` */
  x: number;
  baseline: number;
  /** the ink box that results, y down from the box's top */
  box: { x0: number; x1: number; y0: number; y1: number };
}

/**
 * Lay a number out on a `w × h` box (any unit, y down from the top): numerals `digitH` tall at the
 * most, the ink kept `margin` clear of the left and right edges, and ONE scale for both axes —
 * a number too wide for the box gets smaller, never narrower. See the header for the centring.
 */
export function plateTextLayout(ink: PlateInk, w: number, h: number, digitH: number, margin: number): PlateTextLayout {
  const inkW = ink.x1 - ink.x0;
  let size = digitH / Math.max(1e-6, ink.cap);
  if (inkW > 0) size = Math.min(size, (w - 2 * margin) / inkW);
  const vMid = ink.digits ? ink.cap / 2 : (ink.y0 + ink.y1) / 2;
  const baseline = h / 2 + vMid * size;
  const x = w / 2 - ((ink.x0 + ink.x1) / 2) * size;
  return { size, x, baseline, box: { x0: x + ink.x0 * size, x1: x + ink.x1 * size, y0: baseline - ink.y1 * size, y1: baseline - ink.y0 * size } };
}
