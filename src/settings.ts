import type { GameSettings } from './game';
import { DEFAULT_SPEC } from './sim/spawn';
import { INTAKE_PRESETS, ROBOT_MAX_SIZE, ROBOT_MIN_WIDTH } from './config';
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

const STORAGE_KEY = 'decodesim.settings.v1';

export function defaultSettings(): GameSettings {
  return {
    mode: 'match',
    alliance: 'blue',
    assists: { fieldCentric: true, aimAssist: true, autoIntake: false, autoFire: false },
    spec: { ...DEFAULT_SPEC },
    audio: { sounds: true, voice: true },
    bindings: cloneBindings(DEFAULT_BINDINGS),
    is3D: false,
  };
}

/** load persisted settings, validating field by field — anything stale,
 * missing, or corrupt falls back to its default without crashing */
export function loadSettings(): GameSettings {
  const out = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (s.mode === 'match' || s.mode === 'free') out.mode = s.mode;
    if (s.alliance === 'red' || s.alliance === 'blue') out.alliance = s.alliance;
    if (typeof s.assists === 'object' && s.assists !== null) {
      const a = s.assists as Record<string, unknown>;
      for (const key of ['fieldCentric', 'aimAssist', 'autoIntake', 'autoFire'] as const) {
        if (typeof a[key] === 'boolean') out.assists[key] = a[key] as boolean;
      }
    }
    if (typeof s.spec === 'object' && s.spec !== null) {
      const sp = s.spec as Record<string, unknown>;
      if (sp.intake === 'sloped' || sp.intake === 'vector' || sp.intake === 'triangle') {
        out.spec.intake = sp.intake;
      } else if (sp.intake === 'compact') {
        out.spec.intake = 'sloped'; // legacy preset names from older saves
      } else if (sp.intake === 'extended') {
        out.spec.intake = 'vector';
      }
      const preset = INTAKE_PRESETS[out.spec.intake];
      if (typeof sp.length === 'number') out.spec.length = sp.length;
      // clamp unconditionally: the preset's legal length range must hold even
      // when the saved length is missing or belongs to another preset
      out.spec.length = clamp(out.spec.length, preset.minLength, preset.maxLength);
      if (typeof sp.width === 'number') out.spec.width = clamp(sp.width, ROBOT_MIN_WIDTH, ROBOT_MAX_SIZE);
    }
    if (typeof s.audio === 'object' && s.audio !== null) {
      const au = s.audio as Record<string, unknown>;
      if (typeof au.sounds === 'boolean') out.audio.sounds = au.sounds;
      if (typeof au.voice === 'boolean') out.audio.voice = au.voice;
    }
    out.bindings = mergeBindings(s.bindings);
    if (typeof s.is3D === 'boolean') out.is3D = s.is3D;
  } catch {
    /* corrupt storage or no localStorage — defaults */
  }
  return out;
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable — settings just won't persist */
  }
}
