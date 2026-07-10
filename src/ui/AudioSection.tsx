import { useState } from 'react';
import type { GameSettings } from '../game';
import { loadThemePref, setThemePref, type ThemePref } from '../theme';

const THEMES: { id: ThemePref; title: string; desc: string }[] = [
  { id: 'system', title: 'System', desc: 'Follow your OS setting' },
  { id: 'light', title: 'Light', desc: 'Warm off-white floor' },
  { id: 'dark', title: 'Dark', desc: 'Low-light charcoal' },
];

/**
 * Audio and Visual preferences.
 *
 * The theme is NOT part of `GameSettings` (which syncs to Postgres per account and is
 * read after first paint) — it lives in its own localStorage key via `src/theme.ts`.
 * This component only renders the control; `setThemePref` owns persistence, stamping
 * `data-theme` on <html>, and arming/disarming the OS listener.
 *
 * The three theme buttons are TOGGLE BUTTONS (`aria-pressed`), not an ARIA radiogroup:
 * a radiogroup would owe us roving tabindex + arrow keys, and a partial pattern is worse
 * than none (the same trap as the old Records tablist — Phase 6, F6).
 */
export function AudioSection({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const setAudio = (patch: Partial<GameSettings['audio']>) =>
    onChange({ ...settings, audio: { ...settings.audio, ...patch } });

  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref());
  const pickTheme = (pref: ThemePref): void => {
    setThemePref(pref); // persists + stamps <html data-theme> immediately
    setTheme(pref);
  };

  return (
    <>
      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Audio</span>
        </div>
        <div className="ds-opts two" style={{ padding: 16 }}>
          <button
            className={`ds-opt ${settings.audio.sounds ? 'on' : ''}`}
            aria-pressed={settings.audio.sounds}
            onClick={() => setAudio({ sounds: !settings.audio.sounds })}
          >
            <span className="ot">Sounds {settings.audio.sounds ? 'ON' : 'OFF'}</span>
            <span className="od">All audio</span>
          </button>
          <button
            className={`ds-opt ${settings.audio.voice ? 'on' : ''}`}
            aria-pressed={settings.audio.voice}
            onClick={() => setAudio({ voice: !settings.audio.voice })}
          >
            <span className="ot">Voice lines {settings.audio.voice ? 'ON' : 'OFF'}</span>
            <span className="od">Announcer voice · beeps when off</span>
          </button>
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Visual</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="ds-opts three">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`ds-opt ${theme === t.id ? 'on' : ''}`}
                aria-pressed={theme === t.id}
                onClick={() => pickTheme(t.id)}
              >
                <span className="ot">{t.title}</span>
                <span className="od">{t.desc}</span>
              </button>
            ))}
          </div>
          <p className="ds-hint">
            Theme is stored on this device only — it doesn’t follow your account, and works
            signed out. The field itself always stays dark so alliance and artifact colours read
            the same in every match.
          </p>
        </div>
      </section>
    </>
  );
}
