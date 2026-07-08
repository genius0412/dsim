import type { GameSettings } from './types';
import { DEFAULT_SPEC, coerceSpec, coerceAssists, coerceAutoPath } from './sim/spawn';
import { START_POSES } from './config';
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

const STORAGE_KEY = 'decodesim.settings.v1';

export function defaultSettings(): GameSettings {
  return {
    mode: 'match',
    alliance: 'blue',
    assists: { fieldCentric: true, aimAssist: true, autoIntake: false, autoFire: false },
    spec: { ...DEFAULT_SPEC },
    startIndex: 0,
    practiceDummies: false,
    audio: { sounds: true, voice: true },
    bindings: cloneBindings(DEFAULT_BINDINGS),
    autoPath: null, // Default to no auto path loaded
    autoPathEnabled: false, // Default to auto path disabled
    parkSpeedPct: 30,
  };
}

/** validate an arbitrary settings object field by field — anything stale,
 * missing, or corrupt falls back to its default. Shared by the localStorage
 * load and the per-account (server) load, so both paths sanitize identically. */
export function coerceSettings(raw: unknown): GameSettings {
  const out = defaultSettings();
  try {
    if (typeof raw !== 'object' || raw === null) return out;
    const s = raw as Record<string, unknown>;
    if (s.mode === 'match' || s.mode === 'free') out.mode = s.mode;
    if (s.alliance === 'red' || s.alliance === 'blue') out.alliance = s.alliance;
    // assists + spec share ONE validation path with the server (coerceAssists /
    // coerceSpec in sim/spawn): a hand-edited localStorage spec is clamped to the
    // same legal ranges as a spoofed wire spec, so both surfaces agree exactly.
    out.assists = coerceAssists(s.assists, out.assists);
    if (s.spec !== undefined) out.spec = coerceSpec(s.spec, out.spec);
    if (typeof s.startIndex === 'number') {
      out.startIndex = clamp(Math.round(s.startIndex), 0, START_POSES.length - 1);
    }
    if (typeof s.practiceDummies === 'boolean') out.practiceDummies = s.practiceDummies;
    if (typeof s.audio === 'object' && s.audio !== null) {
      const au = s.audio as Record<string, unknown>;
      if (typeof au.sounds === 'boolean') out.audio.sounds = au.sounds;
      if (typeof au.voice === 'boolean') out.audio.voice = au.voice;
    }
    if (typeof s.parkSpeedPct === 'number') {
      out.parkSpeedPct = clamp(Math.round(s.parkSpeedPct), 0, 100);
    }
    if (typeof s.preferredServerId === 'string') {
      out.preferredServerId = s.preferredServerId;
    }
    out.bindings = mergeBindings(s.bindings);

    // Load autoPath and autoPathEnabled (validated + field-clamped by coerceAutoPath)
    const autoPath = coerceAutoPath(s.autoPath);
    if (autoPath) {
      out.autoPath = autoPath;
      // If autoPathEnabled is not explicitly set or is invalid, enable it if a path is loaded
      if (typeof s.autoPathEnabled === 'boolean') {
        out.autoPathEnabled = s.autoPathEnabled;
      } else {
        out.autoPathEnabled = true;
      }
    } else {
      out.autoPath = null;
      out.autoPathEnabled = false;
    }

  } catch {
    /* corrupt data — defaults */
  }
  return out;
}

/** load persisted settings from localStorage (validated field by field) */
export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    return coerceSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable — settings just won't persist */
  }
}