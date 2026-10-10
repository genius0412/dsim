/** dependency-free: the importer's mesh builder and the 3D scene's import loader both read it */

/**
 * THE FINISH A CAD COLOUR STANDS FOR, as a metal/rough pair (measured 2026-10-03 on the starter-bot
 * kits under the match's lighting, `docs/area/robot-import.md` "Mesh quality"). Every part used to be
 * roughness 0.55, metalness 0.05: matte plastic, which washed near-white anodised aluminium out to
 * chalk under ACES. Read off the colour (linear RGB) alone, since that is all a part carries:
 *  · neutral and light (aluminium, stainless) → metal, roughness 0.4
 *  · neutral and mid-grey (steel, dark anodising) → half metal, roughness 0.45
 *  · dark (rubber, black plastic) → dielectric, roughness 0.6
 *  · saturated (printed and painted parts) → dielectric, roughness 0.45
 */
export function finishOf(color: readonly [number, number, number]): { metalness: number; roughness: number } {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const neutral = max <= 1e-6 || (max - min) / max < 0.15;
  if (lum < 0.06) return { metalness: 0, roughness: 0.6 };
  if (!neutral) return { metalness: 0, roughness: 0.45 };
  if (lum >= 0.4) return { metalness: 1, roughness: 0.4 };
  return { metalness: 0.5, roughness: 0.45 };
}

/** the material every part had before `finishOf`: a stored mesh with it is given its finish on load */
export const OLD_FINISH = { metalness: 0.05, roughness: 0.55 } as const;
