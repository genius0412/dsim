/**
 * THE COMPETITION MODULES' ONLY SOURCE OF CHANCE.
 *
 * A schedule, a ranking coin and a swiss pairing are all recomputed or re-read long after they
 * were first made (a corrected result re-ranks the table, a server restart re-derives the
 * bracket), so every draw has to come out the same from the same inputs. Nothing here touches
 * `Math.random` or the clock; the competition's stored seed is the whole of the randomness.
 */

/** mulberry32: a small, fast 32-bit PRNG. Each call returns the next float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable unsigned 32-bit hash of its parts: FNV-1a over their string forms, then a murmur
 * finalizer. The finalizer matters for the ranking coin: plain FNV-1a of `seed|17` and `seed|18`
 * differ only in their low bits, so neighbouring entry ids would win their coins in id order.
 */
export function hash32(...parts: (string | number)[]): number {
  const s = parts.map(String).join('\u001f');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** a shuffled copy (Fisher–Yates), drawing from `rand` */
export function shuffle<T>(list: readonly T[], rand: () => number): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}
