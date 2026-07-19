import type { GameSettings } from './types';
import {
  DEFAULT_SPEC,
  coerceSpec,
  coerceAssists,
  coerceAutoPath,
  coerceStartPose,
  defaultAssistsFor,
  defaultAssistsByDrivetrain,
} from './sim/spawn';
import { START_POSES, MAX_SAVED_ROBOTS, MAX_SAVED_AUTOS, MAX_SAVED_STARTS } from './config';
import type { StartSel, StartPose } from './types';
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

const STORAGE_KEY = 'decodesim.settings.v1';

export function defaultSettings(): GameSettings {
  return {
    game: 'decode',
    mode: 'match',
    alliance: 'blue',
    // active assists = the default spec's drivetrain slot; library = per-drivetrain defaults
    assists: defaultAssistsFor(DEFAULT_SPEC.drivetrain),
    assistsByDrivetrain: defaultAssistsByDrivetrain(),
    spec: { ...DEFAULT_SPEC },
    savedRobots: [],
    savedAutos: [],
    startIndex: 0,
    startCat: 'close',
    savedStartPoses: { close: [], far: [] },
    // GATE (index 0, close) + AUDIENCE (index 1, far) are the default per-category picks
    startMemory: { close: { index: 0, pose: null }, far: { index: 1, pose: null } },
    practiceDummies: false,
    audio: { sounds: true, voice: true },
    bindings: cloneBindings(DEFAULT_BINDINGS),
    autoPath: null, // Default to no auto path loaded
    autoPathEnabled: false, // Default to auto path disabled
    parkSpeedPct: 30,
    tankControlMode: 'normal',
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
    if (s.game === 'decode' || s.game === 'chain') out.game = s.game;
    if (s.mode === 'match' || s.mode === 'free') out.mode = s.mode;
    if (s.alliance === 'red' || s.alliance === 'blue') out.alliance = s.alliance;
    // assists + spec share ONE validation path with the server (coerceAssists /
    // coerceSpec in sim/spawn): a hand-edited localStorage spec is clamped to the
    // same legal ranges as a spoofed wire spec, so both surfaces agree exactly.
    // Spec is coerced FIRST because its drivetrain decides the active-assist fallback.
    if (s.spec !== undefined) out.spec = coerceSpec(s.spec, out.spec, out.game);
    // per-drivetrain assist library: each slot coerced against its own drivetrain default
    const dfltByDt = defaultAssistsByDrivetrain();
    const hadByDt = typeof s.assistsByDrivetrain === 'object' && s.assistsByDrivetrain !== null;
    const rawByDt = hadByDt ? (s.assistsByDrivetrain as Record<string, unknown>) : {};
    out.assistsByDrivetrain = {
      mecanum: coerceAssists(rawByDt.mecanum, dfltByDt.mecanum),
      tank: coerceAssists(rawByDt.tank, dfltByDt.tank),
      swerve: coerceAssists(rawByDt.swerve, dfltByDt.swerve),
      xdrive: coerceAssists(rawByDt.xdrive, dfltByDt.xdrive),
    };
    // active assists: an explicitly-stored value wins; else this drivetrain's slot
    out.assists = coerceAssists(s.assists, out.assistsByDrivetrain[out.spec.drivetrain]);
    // migration: an old save with no per-drivetrain library seeds the active
    // drivetrain's slot from its stored active assists, so the choice survives a
    // drivetrain round-trip (other drivetrains get the new defaults)
    if (!hadByDt && s.assists !== undefined) {
      out.assistsByDrivetrain[out.spec.drivetrain] = { ...out.assists };
    }
    // saved libraries: validate each entry through the same coercers, cap the count
    if (Array.isArray(s.savedRobots)) {
      out.savedRobots = s.savedRobots.slice(0, MAX_SAVED_ROBOTS).map((r) => coerceSpec(r, undefined, out.game));
    }
    if (Array.isArray(s.savedAutos)) {
      out.savedAutos = s.savedAutos
        .map((a) => coerceAutoPath(a))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .slice(0, MAX_SAVED_AUTOS);
    }
    if (typeof s.startIndex === 'number') {
      out.startIndex = clamp(Math.round(s.startIndex), 0, START_POSES.length - 1);
    }
    // custom start pose: structural + field-bounds only here (G304 legality is
    // enforced spec+alliance-aware at spawn via coerceSetup). null ⇒ use preset.
    if ('startPose' in s) out.startPose = s.startPose == null ? null : coerceStartPose(s.startPose);
    if (s.startCat === 'close' || s.startCat === 'far') out.startCat = s.startCat;
    // saved start-position library: coerce each pose, cap per category
    const coerceSaves = (raw: unknown): StartPose[] =>
      Array.isArray(raw)
        ? raw.map((p) => coerceStartPose(p)).filter((p): p is StartPose => p !== null).slice(0, MAX_SAVED_STARTS)
        : [];
    if (typeof s.savedStartPoses === 'object' && s.savedStartPoses !== null) {
      const sp = s.savedStartPoses as Record<string, unknown>;
      out.savedStartPoses = { close: coerceSaves(sp.close), far: coerceSaves(sp.far) };
    }
    // per-category memory: clamp index, coerce pose
    const coerceSel = (raw: unknown, fallback: StartSel): StartSel => {
      if (typeof raw !== 'object' || raw === null) return fallback;
      const r = raw as Record<string, unknown>;
      const index = typeof r.index === 'number' && Number.isFinite(r.index)
        ? clamp(Math.round(r.index), -1, START_POSES.length - 1)
        : fallback.index;
      const pose = r.pose == null ? null : coerceStartPose(r.pose);
      return { index, pose };
    };
    if (typeof s.startMemory === 'object' && s.startMemory !== null) {
      const m = s.startMemory as Record<string, unknown>;
      out.startMemory = {
        close: coerceSel(m.close, out.startMemory.close),
        far: coerceSel(m.far, out.startMemory.far),
      };
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
    if (s.tankControlMode === 'traditional' || s.tankControlMode === 'normal') {
      out.tankControlMode = s.tankControlMode;
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