import type {
  GameSettings,
  Alliance,
  PracticeSeat,
  PracticeSeatKind,
  PracticeSeats,
} from '../types';
import { StartPositionEditor } from './StartPositionEditor';
import { savedStartCap } from './startPositions';
import { useAds } from '../ads/AdsProvider';
import { selectStart, switchCategory, saveStart, deleteSavedStart } from './startPositions';
import { ChainStartEditor } from './ChainStartEditor';
import { moduleFor } from '../games';
import { OptRow } from './OptRow';
import { practiceSeatsFor } from '../settings';
import { lazy } from 'react';
import { LoadBoundary } from './LoadBoundary';

/** LAZY: only a game that plays Zenith autos shows it, so the main chunk does not carry it. */
const AutonomousSetup = lazy(() => import('./AutonomousSetup').then((m) => ({ default: m.AutonomousSetup })));

/**
 * A BOT TIER, IN SENTENCE CASE. The seam's tiers are opaque lower-case strings a game owns, and
 * `docs/area/ui.md` rules sentence case for every button label — so the presentation happens
 * here rather than the game's list being asked to carry display copy it would then have to keep
 * consistent with the house rules. Shared by the practice control and the lobby's.
 */
export const botLabel = (tier: string): string => tier.charAt(0).toUpperCase() + tier.slice(1);

/** the seats beside the player, in `PracticeSeats` order */
const SEAT_LABELS = ['Partner', 'Opponent 1', 'Opponent 2'] as const;
/** `.ds-opts`'s column modifiers by tile count, so a tier row lines up with the seat row */
const COLS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five' } as const;

/**
 * Match configuration — the pre-game options that belong to the MATCH, not the
 * robot: alliance, start position and the autonomous routine — and, in a card of its own,
 * the practice around the match: its physics and the three other robots.
 * These apply to the SOLO/offline modes (Solo Practice, Free Drive, Records);
 * Ranked and Custom assign alliance + start in the lobby / strategy screen.
 *
 * The MATCH section of `Configure`. It used to be a collapsed `<details>` on the
 * homepage; now it has a route of its own (`/configure/match`), so it renders
 * open. Kept separate from the robot loadout builder on purpose.
 *
 * ⚠️ THE `.pp` (Pedro Pathing visualizer) IMPORT IS GONE, on purpose (owner, 2026-09-25): a path
 * with no commands cannot be an auto a team would run on its robot. Autos are Zenith files, which
 * name the robot's own commands (`AutonomousSetup`).
 */
export function MatchSetup({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  const setAlliance = (alliance: Alliance) => set({ alliance });
  // the start-position editor is built on DECODE's G304 legality + goal geometry —
  // hidden for the Chain Reaction shell (its start rules arrive with its manual).
  const isDecode = settings.game === 'decode';
  // a game that brings its own start editor supplies it through the module slot;
  // absent ⇒ the two inline branches below (DECODE's and CR's), unchanged
  const StartEd = moduleFor(settings.game).startEditor;
  // the saved-pose cap a game's own editor is handed (it cannot read the ads context itself)
  const maxSaved = savedStartCap(useAds().supporter);
  // BIOBUZZ 3D SEAM (Day 1, `docs/biobuzz/plan-3d.md` §2.1/§6): only a game whose sim can
  // actually step the second physics offers the picker — absent `physicsOptions` (DECODE,
  // Chain Reaction) reads as `['2d']` only, so this never shows for them.
  const physicsOptions = moduleFor(settings.game).physicsOptions;
  // THE PRACTICE SEATS (`practiceSeatsFor`). The tier list is the GAME's
  // (`GameSimModule.bot.tiers`) — opaque strings, so a game can add or rename a difficulty
  // without this file changing — and its absence is what takes AI off the menu for DECODE and
  // Chain Reaction. Offering a driver nothing can play is worse than offering nothing.
  const botDriver = moduleFor(settings.game).bot;
  const seats = practiceSeatsFor(settings, settings.game);
  const setSeat = (i: number, patch: Partial<PracticeSeat>): void => {
    const next = seats.map((x, j) => (j === i ? { ...x, ...patch } : x)) as PracticeSeats;
    set({ practiceSeats: { ...settings.practiceSeats, [settings.game]: next } });
  };

  return (
    <>
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Match setup</h2>
      </div>

      <div className="ds-panel-body stack">
        <section className="ds-sec">
          <h2>Alliance</h2>
          {/* ALL CAPS here is the deliberate one `docs/area/ui.md` records: an alliance reads
              RED and BLUE on the FTC scoring display and in this app's own HUD chips, and a
              sentence-case alliance would be the only place in DSIM that disagrees. */}
          <div className="ds-opts two">
            <button
              className={`ds-opt red ${settings.alliance === 'red' ? 'on' : ''}`}
              aria-pressed={settings.alliance === 'red'}
              onClick={() => setAlliance('red')}
            >
              <span className="ot">RED</span>
            </button>
            <button
              className={`ds-opt blue ${settings.alliance === 'blue' ? 'on' : ''}`}
              aria-pressed={settings.alliance === 'blue'}
              onClick={() => setAlliance('blue')}
            >
              <span className="ot">BLUE</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Start position</h2>
          {StartEd ? (
            <StartEd
              maxSaved={maxSaved}
              spec={settings.spec}
              alliance={settings.alliance}
              value={settings.startPose}
              startIndex={settings.startIndex ?? 0}
              category={settings.startCat}
              saved={settings.savedStartPoses}
              onChange={(startPose) => startPose && set(selectStart(settings, { index: -1, pose: startPose }))}
              onPickPreset={(i) => set(selectStart(settings, { index: i, pose: null }))}
              onCategory={(c) => set(switchCategory(settings, c))}
              onSave={(pose) => set(saveStart(settings, pose))}
              onDeleteSaved={(c, i) => set(deleteSavedStart(settings, c, i))}
            />
          ) : isDecode ? (
            <StartPositionEditor
              spec={settings.spec}
              alliance={settings.alliance}
              value={settings.startPose}
              startIndex={settings.startIndex}
              category={settings.startCat}
              saved={settings.savedStartPoses}
              onChange={(startPose) => startPose && set(selectStart(settings, { index: -1, pose: startPose }))}
              onPickPreset={(i) => set(selectStart(settings, { index: i, pose: null }))}
              onCategory={(c) => set(switchCategory(settings, c))}
              onSave={(pose) => set(saveStart(settings, pose))}
              onDeleteSaved={(c, i) => set(deleteSavedStart(settings, c, i))}
            />
          ) : (
            <ChainStartEditor
              spec={settings.spec}
              alliance={settings.alliance}
              value={settings.startPose}
              startIndex={settings.startIndex ?? 0}
              category={settings.startCat}
              saved={settings.savedStartPoses}
              onChange={(startPose) => set(selectStart(settings, { index: -1, pose: startPose }))}
              onPickPreset={(i) => set(selectStart(settings, { index: i, pose: null }))}
              onCategory={(c) => set(switchCategory(settings, c))}
              onSave={(pose) => set(saveStart(settings, pose))}
              onDeleteSaved={(c, i) => set(deleteSavedStart(settings, c, i))}
            />
          )}
        </section>

        {moduleFor(settings.game).zenithAutos && (
          <LoadBoundary what="the autonomous settings" fallback={<div className="ds-loading">Loading autonomous settings…</div>}>
            <AutonomousSetup settings={settings} />
          </LoadBoundary>
        )}

      </div>
    </section>

    {/* PRACTICE: WHAT THE FIELD AROUND YOU IS — its own card (owner, 2026-09-23), because none
        of it is the match you are setting up: it is the practice around it, and it applies to
        Free drive as much as to Solo practice. Ranked, record and Custom rooms decide all of it
        for themselves. */}
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Practice</h2>
      </div>
      <div className="ds-panel-body stack">
        {/* BIOBUZZ 3D SEAM: which physics a SOLO practice steps on — absent reads '3d',
            the seam's default (`settings.ts`). Ranked/matchmade/record rooms always run
            3D; this picker only ever applies here.
            ⚠️ THE 2D/3D *VIEW* PICKER THAT USED TO SIT BESIDE IT IS GONE. It wrote the same
            per-device store as Graphics ▸ Field view, so there were two controls for one
            setting on two screens. */}
        {physicsOptions?.includes('3d') && (
          <section className="ds-sec">
            <h2>Practice physics</h2>
            <OptRow<'2d' | '3d'>
              value={settings.practicePhysics ?? '3d'}
              cols="two"
              onPick={(practicePhysics) => set({ practicePhysics })}
              options={[
                { v: '2d', t: '2D', d: 'Lighter on a slow machine' },
                { v: '3d', t: '3D', d: 'What ranked and record rooms run' },
              ]}
            />
          </section>
        )}

        {/* THE THREE OTHER ROBOTS, one block each: what the seat is, then — only in a game with
            an AI driver — its difficulty. The difficulty row is DISABLED rather than absent
            while the seat is not AI, so picking AI moves nothing below it. A Dummy is an inert
            robot to be bumped into; it never drives. */}
        <section className="ds-sec">
          <h2>Robots</h2>
          {SEAT_LABELS.map((label, i) => (
            <div className="ds-seat" key={label}>
              <OptRow<PracticeSeatKind>
                label={label}
                value={botDriver || seats[i].kind !== 'ai' ? seats[i].kind : 'none'}
                cols={botDriver ? 'three' : 'two'}
                mini
                onPick={(kind) => setSeat(i, { kind })}
                options={[
                  { v: 'none', t: 'None' },
                  { v: 'dummy', t: 'Dummy' },
                  ...(botDriver ? [{ v: 'ai' as const, t: 'AI' }] : []),
                ]}
              />
              {botDriver && (
                <OptRow<string>
                  value={botDriver.coerceTier(seats[i].tier)}
                  cols={COLS[botDriver.tiers.length as keyof typeof COLS]}
                  mini
                  disabled={seats[i].kind !== 'ai'}
                  onPick={(tier) => setSeat(i, { tier })}
                  options={botDriver.tiers.map((t) => ({ v: t, t: botLabel(t) }))}
                />
              )}
            </div>
          ))}
        </section>
      </div>
    </section>
    </>
  );
}
