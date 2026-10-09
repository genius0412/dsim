/**
 * 3MF, read with three's `ThreeMFLoader`: its own chunk, reached by `parse.ts`'s `import()` only when a
 * 3MF is dropped, so the loader, fflate's unzip and the small DOM are not in the import worker
 * every GLB and STL import loads.
 */
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import type { MeshPart } from '../geometry';
import type { LengthUnit } from '../types';
import { MiniDOMParser } from './miniDom';
import { partsFromObject } from './parse';

const MF_UNITS: Record<string, LengthUnit> = { millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };

/** the `unit` attribute of a 3MF's model part (millimetre when absent, per the 3MF spec) */
export function threeMfUnit(zip: Uint8Array): LengthUnit | null {
  try {
    const entries = unzipSync(zip, { filter: (f) => /\.model$/i.test(f.name) });
    for (const name of Object.keys(entries)) {
      const head = new TextDecoder().decode(entries[name].subarray(0, 4096));
      const m = /<model\b[^>]*\bunit\s*=\s*["']([a-z]+)["']/i.exec(head);
      if (/<model\b/i.test(head)) return m ? (MF_UNITS[m[1].toLowerCase()] ?? null) : 'mm';
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A 3MF's parts through three's `ThreeMFLoader`, with the page's `DOMParser` where there is one and
 * `miniDom.ts`'s where there is not (a worker), installed for the parse and removed after it.
 * `dom: 'mini'` forces the small one, so a check can hold the two to the same parts.
 */
export function parseThreeMf(buf: ArrayBuffer, dom: 'auto' | 'mini' = 'auto'): MeshPart[] {
  const g = globalThis as unknown as { DOMParser?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, 'DOMParser');
  const before = g.DOMParser;
  const swap = dom === 'mini' || typeof before === 'undefined';
  if (swap) g.DOMParser = MiniDOMParser;
  try {
    return partsFromObject(new ThreeMFLoader().parse(buf), true);
  } finally {
    if (swap) {
      if (had) g.DOMParser = before;
      else delete g.DOMParser;
    }
  }
}
