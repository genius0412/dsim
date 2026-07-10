import type { GameSettings } from '../game';

/**
 * Audio preferences. Lifted verbatim out of Account when Configure became the
 * home for everything you tune before a match; the settings themselves are
 * unchanged (`settings.audio.sounds` is the master, `voice` falls back to beeps).
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

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Audio</span>
      </div>
      <div className="ds-opts two" style={{ padding: 16 }}>
        <button
          className={`ds-opt ${settings.audio.sounds ? 'on' : ''}`}
          onClick={() => setAudio({ sounds: !settings.audio.sounds })}
        >
          <span className="ot">Sounds {settings.audio.sounds ? 'ON' : 'OFF'}</span>
          <span className="od">All audio</span>
        </button>
        <button
          className={`ds-opt ${settings.audio.voice ? 'on' : ''}`}
          onClick={() => setAudio({ voice: !settings.audio.voice })}
        >
          <span className="ot">Voice lines {settings.audio.voice ? 'ON' : 'OFF'}</span>
          <span className="od">Announcer voice · beeps when off</span>
        </button>
      </div>
    </section>
  );
}
