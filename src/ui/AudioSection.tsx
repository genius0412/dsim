import { useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { MatchAudio } from '../audio';
import { loadThemePref, setThemePref, type ThemePref } from '../theme';
import { PERF_DISPLAY_LEVELS } from '../settings';
import type { PerfDisplay } from '../types';
import { OptRow, ToggleRow } from './OptRow';
import { rangeFill } from './rangeFill';
import { PaceSetting } from './pace/PaceSetting';

/**
 * One volume category. Auditions on RELEASE (pointer-up / key-up), never on
 * `onChange` — a drag fires change on every step and would stutter the preview
 * over itself. `muted` greys the value when master is at 0, so a row reading
 * "80%" while nothing plays doesn't look like a bug.
 */
function VolumeRow({
  label,
  value,
  onChange,
  onAudition,
  muted = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onAudition: () => void;
  muted?: boolean;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="ds-field">
      <span className="cap">
        {label}{' '}
        <span className={`val${muted ? ' muted' : ''}`}>
          {pct}%
        </span>
      </span>
      <input
        className="ds-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        style={rangeFill(pct, 0, 100)}
        aria-label={label}
        aria-valuetext={`${pct}%`}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onAudition}
        onKeyUp={onAudition}
      />
    </label>
  );
}

const THEMES: { id: ThemePref; title: string }[] = [
  { id: 'system', title: 'System' },
  { id: 'light', title: 'Light' },
  { id: 'dark', title: 'Dark' },
];

/** the performance read-out's four levels. Sentence case, like every other `ds-opt`. */
const PERF_DISPLAY_LABEL: Record<PerfDisplay, string> = {
  off: 'Off',
  simple: 'Simple',
  detailed: 'Detailed',
  graphs: 'Graphs',
};

/**
 * ...and what each one actually adds.
 *
 * These blurbs survive `docs/ui-standard.md` §8 ("descriptions are deleted, not shortened")
 * because they are the only thing that distinguishes four tiles whose labels are adjectives:
 * "Detailed" cannot say what it details, and picking between them IS the task.
 */
const PERF_DISPLAY_BLURB: Record<PerfDisplay, string> = {
  off: 'Nothing over the field',
  simple: 'Frame rate, and ping when online',
  detailed: 'Frame, sim and draw times, 3D counters, link',
  graphs: 'Detailed, plus frame-time and ping traces',
};

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
  const vol = settings.audio.volume;
  const setVolume = (patch: Partial<GameSettings['audio']['volume']>) =>
    onChange({ ...settings, audio: { ...settings.audio, volume: { ...vol, ...patch } } });

  // own MatchAudio instance so a slider can AUDITION its category — the game
  // controller isn't up on this screen. Levels are pushed in on every render so
  // the preview always plays at what the slider currently reads.
  const audioRef = useRef<MatchAudio | null>(null);
  audioRef.current ??= new MatchAudio();
  const audio = audioRef.current;
  audio.masterVolume = vol.master;
  audio.gameVolume = vol.game;
  audio.shootVolume = vol.shoot;
  audio.intakeVolume = vol.intake;
  audio.gateVolume = vol.gate;
  audio.beepVolume = vol.beep;
  audio.alertVolume = vol.alert;
  audio.voiceVolume = vol.voice;

  const silent = vol.master <= 0;

  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref());
  const pickTheme = (pref: ThemePref): void => {
    setThemePref(pref); // persists + stamps <html data-theme> immediately
    setTheme(pref);
  };

  return (
    <>
      <section className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Audio</h2>
        </div>
        <div className="ds-panel-body stack">
          <VolumeRow
            label="Master"
            value={vol.master}
            onChange={(master) => setVolume({ master })}
            onAudition={() => audio.beep()}
          />
          <VolumeRow
            label="Game sounds"
            value={vol.game}
            muted={silent}
            onChange={(game) => setVolume({ game })}
            onAudition={() => audio.play('resume')}
          />
          <VolumeRow
            label="Voice lines"
            value={vol.voice}
            muted={silent}
            onChange={(voice) => setVolume({ voice })}
            onAudition={() => audio.say('Volume', true)}
          />
          {/* ONE ROW PER EMITTER, BEHIND A FOLD. These five were a single slider labelled
              "Beeping" — which moved the launcher, the intake and the gate as well, and was
              named after the rarest of them — so each one exists because the label is now
              checkable against its own audition. But eight identical sliders in a column is
              still a wall, and three of them (master, game, voice) are the ones anybody
              actually moves. `.inset`: this is inside a panel body, and a card in a card is
              what the fold is meant to avoid. */}
          <details className="ds-fold inset">
            <summary>Individual sounds</summary>
            <div className="ds-fold-body">
              <VolumeRow
                label="Shooter"
                value={vol.shoot}
                muted={silent}
                onChange={(shoot) => setVolume({ shoot })}
                onAudition={() => audio.sfxShoot()}
              />
              <VolumeRow
                label="Intake"
                value={vol.intake}
                muted={silent}
                onChange={(intake) => setVolume({ intake })}
                onAudition={() => audio.sfxIntake()}
              />
              <VolumeRow
                label="Classifier gate"
                value={vol.gate}
                muted={silent}
                onChange={(gate) => setVolume({ gate })}
                onAudition={() => audio.sfxGate()}
              />
              <VolumeRow
                label="Countdown beeps"
                value={vol.beep}
                muted={silent}
                onChange={(beep) => setVolume({ beep })}
                onAudition={() => audio.beep()}
              />
              <VolumeRow
                label="Match alerts"
                value={vol.alert}
                muted={silent}
                onChange={(alert) => setVolume({ alert })}
                onAudition={() => audio.sfxMatchFound()}
              />
            </div>
          </details>
          {/* NO "master is at 0%" line. The `muted` prop already greys every value in
              the panel for exactly this state and the Master row itself reads 0%; a
              sentence that appears and disappears also moved the panel's height. */}
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Visual</h2>
        </div>
        <div className="ds-panel-body stack">
          <OptRow<ThemePref>
            label="Theme"
            value={theme}
            cols="three"
            onPick={pickTheme}
            options={THEMES.map((t) => ({ v: t.id, t: t.title }))}
          />
          {/* the stack of messages in the field's top-left corner during a match
              (scoring, gate, penalties). It is a read-out and never a control, so
              turning it off costs nothing but the reading. */}
          <ToggleRow
            label="In-match messages"
            value={settings.showEventLog}
            onPick={(showEventLog) => onChange({ ...settings, showEventLog })}
          />
          {/**
            * THE PERFORMANCE READ-OUT'S LEVEL — beside the messages toggle, because they are
            * the two read-outs a match draws over the field and they sit in opposite corners
            * of it.
            *
            * HERE AND NOT IN GRAPHICS. Every control in that section is per DEVICE
            * (`localStorage['decodesim.graphics']`) and 3D-only; this is a `GameSettings`
            * field that syncs per account and applies to all three games in both views. It
            * replaces the 3D-only "Performance overlay" row that used to live there.
            *
            * Four tiles rather than a switch and a checkbox: the whole point of the change is
            * that ONE setting decides what is drawn, with nothing to click on the field.
            */}
          <OptRow<PerfDisplay>
            label="Performance read-out"
            value={settings.perfDisplay}
            cols="four"
            onPick={(perfDisplay) => onChange({ ...settings, perfDisplay })}
            options={PERF_DISPLAY_LEVELS.map((lv) => ({
              v: lv,
              t: PERF_DISPLAY_LABEL[lv],
              d: PERF_DISPLAY_BLURB[lv],
            }))}
          />
          {/* the third in-match read-out: the +/- under your score (`src/ui/pace`) */}
          <PaceSetting settings={settings} onChange={onChange} />
        </div>
      </section>
    </>
  );
}
