import { lazy } from 'react';
import { LoadBoundary } from './LoadBoundary';
import type { GameSettings } from '../game';
import { Menu } from './Menu';
import { MatchSetup } from './MatchSetup';
import { ControlsSection } from './ControlsSection';
import { AudioSection } from './AudioSection';
import { NetworkSection } from './NetworkSection';
import { moduleFor } from '../games';
/**
 * LAZY, unlike its five siblings — and the reason is the bundle, not the screen.
 *
 * `GraphicsSection` carries the whole nineteen-setting model (`graphics/settings.ts`: the preset
 * table, the coercion, the store), which nothing else in the MAIN chunk reads — the renderer
 * reads it from the scene chunk, and the scene chunk is already lazy. Statically importing it
 * here put ~5 KB gzipped of 3D graphics settings into the bundle every player of every game
 * downloads, including the ones on DECODE who will never open a 3D view. `scripts/bundleaudit.mjs`
 * is the thing that would have caught it a week later; this is catching it now.
 *
 * The cost is one extra request the first time somebody opens `/configure/graphics`, behind a
 * `.ds-loading` line — the same state every list on the site already has.
 */
const GraphicsSection = lazy(() => import('./GraphicsSection').then((m) => ({ default: m.GraphicsSection })));

/**
 * TASK ORDER, not the order the sections were built in: build the robot, learn to drive it,
 * set up the session you will drive it in, then the output settings, then the connection.
 * `network` is last because it is the one a player opens least — it holds client prediction,
 * which moved out of Controls on 2026-09-22 (see `NetworkSection`).
 *
 * ⚠️ THE ROUTE KEYS ARE UNTOUCHED. This array is the ORDER ON SCREEN; `/configure/<key>` is a
 * shipped, deep-linkable URL (`audio` is still the key for Audio and Visual), and reordering a
 * list must never break a link somebody has bookmarked.
 */
export const CONFIGURE_SECTIONS = ['robot', 'controls', 'match', 'audio', 'graphics', 'network'] as const;
export type ConfigureSection = (typeof CONFIGURE_SECTIONS)[number];

export function isConfigureSection(s: string | null): s is ConfigureSection {
  return s !== null && (CONFIGURE_SECTIONS as readonly string[]).includes(s);
}

/**
 * A HINT NAMES WHAT IS BEHIND THE LABEL; it never restates it (`NavRail` settled the rule for
 * the four top-level destinations). Cut on 2026-09-22 and restored on 2026-09-23 (owner): every
 * row carries one, since a sub-nav where some rows have a second line and others do not reads
 * as unfinished. The narrow layouts hide `.sh` with the rail's `.rh`.
 */
const LABELS: Record<ConfigureSection, { label: string; hint: string }> = {
  robot: { label: 'Robot', hint: 'Presets, build, intake' },
  controls: { label: 'Controls', hint: 'Keyboard & gamepad' },
  match: { label: 'Match', hint: 'Alliance, start, autos' },
  // route key stays 'audio' — /configure/audio is deep-linkable and already shipped
  audio: { label: 'Audio and visual', hint: 'Sounds, voice & theme' },
  graphics: { label: 'Graphics', hint: '3D view quality' },
  network: { label: 'Network', hint: 'Client prediction' },
};

/**
 * Configure — everything you tune before a match, behind one destination with a
 * sub-nav. Each section is an EXISTING component, moved rather than rewritten:
 * `Menu` (the robot builder), `MatchSetup` (was a collapsed panel on Home), and
 * `ControlsSection` + `AudioSection` (were buried in Account). Account keeps only
 * identity, server region, and the settings reset. `NetworkSection` is the one written for
 * it, when client prediction left Controls.
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
  onTutorial,
  onImport,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  section: ConfigureSection;
  onSection: (s: ConfigureSection) => void;
  /** launch Free Drive with the on-screen touch-control layout editor open */
  onEditTouchControls: () => void;
  /** run the tutorial (roadmap item 6); absent when the active game has no tutorial. */
  onTutorial?: () => void;
  /** open the robot importer: a new import, or `id` to edit a library robot */
  onImport?: (id?: string) => void;
}) {
  // Graphics only exists for a game with a 3D view (the module's `scene` slot) — every row in it
  // is a 3D setting. The route key stays valid so a bookmarked /configure/graphics under a 2D
  // game lands on Robot rather than a blank page (design review 22-03).
  const has3d = !!moduleFor(settings.game).scene;
  const sections = CONFIGURE_SECTIONS.filter((s) => s !== 'graphics' || has3d);
  if (!sections.includes(section)) section = 'robot';
  return (
    <>
      <h1 className="ds-h1">Configure</h1>

      <div className="ds-subnav-layout">
        {/* LINKS, not buttons: each section is a real route, so it can be middle-clicked,
            opened in a tab or copied. A plain left click routes in-app, the same as the
            footer's `FootLink` (AppShell.tsx); a modified click is left to the browser. */}
        <nav className="ds-subnav" aria-label="Configure sections">
          {sections.map((s) => (
            <a
              key={s}
              className={`ds-subnav-btn${section === s ? ' on' : ''}`}
              href={`/${settings.game}/configure/${s}`}
              aria-current={section === s ? 'page' : undefined}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onSection(s);
              }}
            >
              <span className="sl">{LABELS[s].label}</span>
              <span className="sh">{LABELS[s].hint}</span>
            </a>
          ))}
        </nav>

        <div className="ds-subnav-body">
          {section === 'robot' && <Menu settings={settings} onChange={onChange} onImport={onImport} />}
          {section === 'match' && <MatchSetup settings={settings} onChange={onChange} />}
          {section === 'controls' && (
            <ControlsSection
              tutorialGame={settings.game}
              bindings={settings.bindings}
              onChange={(bindings) => onChange({ ...settings, bindings })}
              onEditTouchControls={onEditTouchControls}
              onTutorial={onTutorial}
            />
          )}
          {section === 'audio' && <AudioSection settings={settings} onChange={onChange} />}
          {section === 'graphics' && (
            <LoadBoundary what="the graphics settings" fallback={<div className="ds-loading">Loading graphics settings…</div>}>
              <GraphicsSection />
            </LoadBoundary>
          )}
          {section === 'network' && <NetworkSection />}
        </div>
      </div>
    </>
  );
}
