import type { GameSettings, AutoPathData } from './game'; // Import AutoPathData from game for consistency
import { DEFAULT_SPEC } from './sim/spawn';
import {
  INTAKE_PRESETS,
  ROBOT_MAX_SIZE,
  ROBOT_MIN_WIDTH,
  ROBOT_MIN_MASS,
  ROBOT_MAX_MASS,
  ROBOT_MIN_RPM,
  ROBOT_MAX_RPM,
  START_POSES,
} from './config';
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

const STORAGE_KEY = 'decodesim.settings.v1';

// Helper function to validate loaded AutoPathData
function isValidAutoPathData(data: any): data is AutoPathData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.fileName === 'string' &&
    typeof data.startPoint === 'object' &&
    data.startPoint !== null &&
    Array.isArray(data.lines)
    // Add more rigorous checks if necessary, e.g., for startPoint and lines structure
  );
}

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
      if (typeof sp.name === 'string') out.spec.name = sp.name.slice(0, 24);
      if (typeof sp.teamName === 'string') out.spec.teamName = sp.teamName.slice(0, 24);
      if (typeof sp.teamNumber === 'number' && Number.isFinite(sp.teamNumber)) {
        out.spec.teamNumber = clamp(Math.round(sp.teamNumber), 0, 99999);
      }
      if (
        sp.drivetrain === 'mecanum' ||
        sp.drivetrain === 'tank' ||
        sp.drivetrain === 'swerve' ||
        sp.drivetrain === 'xdrive'
      ) {
        out.spec.drivetrain = sp.drivetrain;
      }
      if (typeof sp.massLb === 'number') {
        out.spec.massLb = clamp(sp.massLb, ROBOT_MIN_MASS, ROBOT_MAX_MASS);
      }
      if (typeof sp.driveRpm === 'number') {
        out.spec.driveRpm = clamp(sp.driveRpm, ROBOT_MIN_RPM, ROBOT_MAX_RPM);
      }
      if (typeof sp.flywheelInertia === 'number') {
        out.spec.flywheelInertia = clamp(sp.flywheelInertia, 0, 1);
      }
      if (typeof sp.canSort === 'boolean') out.spec.canSort = sp.canSort;
    }
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
    out.bindings = mergeBindings(s.bindings);

    // Load autoPath and autoPathEnabled
    if (s.autoPath && isValidAutoPathData(s.autoPath)) {
      out.autoPath = s.autoPath;
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