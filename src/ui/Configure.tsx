import type { GameSettings } from '../game';
import { APP_NAME } from '../seasons';
import { Menu } from './Menu';
import { MatchSetup } from './MatchSetup';
import { ControlsSection } from './ControlsSection';
import { AudioSection } from './AudioSection';

export const CONFIGURE_SECTIONS = ['robot', 'match', 'controls', 'audio'] as const;
export type ConfigureSection = (typeof CONFIGURE_SECTIONS)[number];

export function isConfigureSection(s: string | null): s is ConfigureSection {
  return s !== null && (CONFIGURE_SECTIONS as readonly string[]).includes(s);
}

const LABELS: Record<ConfigureSection, { label: string }> = {
  robot: { label: 'Robot' },
  match: { label: 'Match' },
  controls: { label: 'Controls' },
  // route key stays 'audio' — /configure/audio is deep-linkable and already shipped
  audio: { label: 'Audio and Visual' },
};

/**
 * Configure — everything you tune before a match, behind one destination with a
 * sub-nav. Each section is an EXISTING component, moved rather than rewritten:
 * `Menu` (the robot builder), `MatchSetup` (was a collapsed panel on Home), and
 * `ControlsSection` + `AudioSection` (were buried in Account). Account keeps only
 * identity, server region, and the settings reset.
 *
 * The active section is a real route (`/configure/<section>`), so it is
 * deep-linkable and survives back/forward.
 */
export function Configure({
  settings,
  onChange,
  section,
  onSection,
  onEditTouchControls,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  section: ConfigureSection;
  onSection: (s: ConfigureSection) => void;
  /** launch Free Drive with the on-screen touch-control layout editor open */
  onEditTouchControls: () => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Configure</p>
      <h1 className="ds-h1">Configure</h1>

      <div className="ds-subnav-layout">
        <nav className="ds-subnav" aria-label="Configure sections">
          {CONFIGURE_SECTIONS.map((s) => (
            <button
              key={s}
              className={`ds-subnav-btn${section === s ? ' on' : ''}`}
              aria-current={section === s ? 'page' : undefined}
              onClick={() => onSection(s)}
            >
              <span className="sl">{LABELS[s].label}</span>
            </button>
          ))}
        </nav>

        <div className="ds-subnav-body">
          {section === 'robot' && <Menu settings={settings} onChange={onChange} />}
          {section === 'match' && <MatchSetup settings={settings} onChange={onChange} />}
          {section === 'controls' && (
            <ControlsSection
              bindings={settings.bindings}
              onChange={(bindings) => onChange({ ...settings, bindings })}
              onEditTouchControls={onEditTouchControls}
            />
          )}
          {section === 'audio' && <AudioSection settings={settings} onChange={onChange} />}
        </div>
      </div>
    </>
  );
}
