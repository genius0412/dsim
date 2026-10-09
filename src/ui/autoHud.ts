import type { HudSnapshot } from '../game';

/**
 * WHAT THE MATCH SCREEN SAYS ABOUT THE ZENITH AUTO (docs/area/autos.md). DOM-free and in the main
 * chunk, so the AUTO smoke lane holds the words: before this, a file the seat could not load, or
 * one Zenith refuses (a start in the other half, a path through the HIVE), drove nothing or drove
 * wrong with nothing on screen but an event-log line most drivers never read.
 */
type AutoHud = Pick<HudSnapshot, 'auto' | 'phase'>;

/** The line on the second HUD card: the step running (or STUCK on it), AUTO DONE, or AUTO OFF when it cannot run. */
export function autoHudLine({ auto, phase }: AutoHud): string | null {
  if (!auto) return null;
  if (auto.state === 'running' && auto.stuck) return `AUTO STUCK ON ${(auto.stepId ?? auto.name).toUpperCase()}`;
  if (auto.state === 'running') return `AUTO · ${(auto.stepId ?? auto.name).toUpperCase()}`;
  const early = phase === 'pre' || phase === 'auto' || phase === 'freeplay';
  if (auto.state === 'done' && (phase === 'auto' || phase === 'freeplay')) return 'AUTO DONE';
  if (auto.state === 'error' && early) return 'AUTO OFF';
  return null;
}

/**
 * The pre-match panel's line: which auto AUTO plays, why it will not, or what Zenith flags in it.
 * `tone` picks the `.ds-hint` modifier.
 */
export function autoPreNotice({ auto }: Pick<HudSnapshot, 'auto'>): { tone: 'ok' | 'warn' | 'err'; text: string } | null {
  if (!auto) return null;
  if (auto.state === 'error') {
    return { tone: 'err', text: `Auto off: ${auto.error ?? 'the auto could not be loaded.'} You drive in AUTO.` };
  }
  const n = auto.problems.length;
  if (n > 0) {
    return {
      tone: 'warn',
      text: `${auto.name} plays in AUTO, but Zenith flags ${n === 1 ? 'a problem' : `${n} problems`}. ${auto.problems[0]}`,
    };
  }
  return { tone: 'ok', text: `${auto.name} plays in AUTO.` };
}
