// THE ANTI-ALIASING PIPELINE'S FINGERPRINT: what an edge-error measurement (`baseline.json`) was
// taken against. The RENDER lane recomputes it and fails when it no longer matches the recording,
// so the AA path cannot change without being measured again (`npm run aaprobe -- --record`).
//
// It covers what decides how an edge is resolved, and nothing cosmetic: each column's sample count,
// render scale and pixel budget, the decode shader, the tone curve's constants and the late layer.
// `npx tsx scripts/aa-probe/fingerprint.ts` prints it (the probe records it that way).
import { GFX_PIXEL_BUDGET, GFX_PRESETS, GFX_TIERS, msaaSamples } from '../../src/games/biobuzz/graphics/settings';
import { ACES_IN, ACES_OUT, ACES_CLIP, DECODE_FRAG, LATE_LAYER } from '../../src/games/biobuzz/scene/renderSplitPass';

export function aaPipelineText(): string {
  const columns = GFX_TIERS.map((t) => `${t}:${msaaSamples(GFX_PRESETS[t].aa)}x:${GFX_PRESETS[t].renderScale}%:${GFX_PIXEL_BUDGET[t]}`);
  return [columns.join('|'), ACES_IN.join(','), ACES_OUT.join(','), ACES_CLIP, LATE_LAYER, DECODE_FRAG.replace(/\s+/g, ' ').trim()].join('\n');
}

/** FNV-1a, 32 bits, as hex: stable, dependency-free, and enough to notice a change */
export function aaFingerprint(): string {
  let h = 0x811c9dc5;
  for (const ch of aaPipelineText()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

if (process.argv[1] && /fingerprint\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) console.log(aaFingerprint());
