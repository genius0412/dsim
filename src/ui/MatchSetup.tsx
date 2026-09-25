import { useState } from 'react';
import type {
  GameSettings,
  AutoPathData,
  PathLine,
  SequenceItem,
  PathPoint,
  Vec2,
  Alliance,
  PracticeSeat,
  PracticeSeatKind,
  PracticeSeats,
} from '../types';
import { MAX_SAVED_AUTOS } from '../config';
import { StartPositionEditor } from './StartPositionEditor';
import { savedStartCap } from './startPositions';
import { useAds } from '../ads/AdsProvider';
import { selectStart, switchCategory, saveStart, deleteSavedStart } from './startPositions';
import { ChainStartEditor } from './ChainStartEditor';
import { moduleFor } from '../games';
import { OptRow, ToggleRow } from './OptRow';
import { practiceSeatsFor } from '../settings';
import { AutonomousSetup } from './AutonomousSetup';

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
 * robot: alliance, start position and an imported auto path — and, in a card of its own,
 * the practice around the match: its physics and the three other robots.
 * These apply to the SOLO/offline modes (Solo Practice, Free Drive, Records);
 * Ranked and Custom assign alliance + start in the lobby / strategy screen.
 *
 * The MATCH section of `Configure`. It used to be a collapsed `<details>` on the
 * homepage; now it has a route of its own (`/configure/match`), so it renders
 * open. Kept separate from the robot loadout builder on purpose. `.pp` import +
 * the Pedro-Pathing → sim coordinate transform live here.
 */
export function MatchSetup({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  /** the outcome of the last .pp import, shown in the auto-path section */
  const [notice, setNotice] = useState<{ bad: boolean; text: string } | null>(null);
  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  /** NOT a toast — CLAUDE.md forbids those, and this is an inline `<p>` under the
   * auto-path section. Named for what it is so nobody goes looking for a toast system. */
  function setImportNotice(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') {
    setNotice({ bad: type === 'error' || type === 'warning', text: message });
  }

  // --- Pedro Pathing (.pp) → sim coordinate transform ---
  const PP_FIELD_SIZE = 141.5;
  const PP_CENTER_OFFSET = PP_FIELD_SIZE / 2; // 70.75
  const SIM_FIELD_SIZE = 144; // From -72 to 72
  const SCALE_FACTOR = SIM_FIELD_SIZE / PP_FIELD_SIZE;

  function transformPpCoordinate(coord: Vec2): Vec2 {
    return {
      x: (coord.x - PP_CENTER_OFFSET) * SCALE_FACTOR,
      y: (coord.y - PP_CENTER_OFFSET) * SCALE_FACTOR,
    };
  }
  function transformPathPoint(pathPoint: PathPoint): PathPoint {
    const transformed = transformPpCoordinate(pathPoint);
    return { ...pathPoint, x: transformed.x, y: transformed.y };
  }

  function normalizeLines(input: PathLine[] = []): PathLine[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      waitBeforeMs: Math.max(0, Number(line.waitBeforeMs ?? (line as any).waitBefore?.durationMs ?? 0)),
      waitAfterMs: Math.max(0, Number(line.waitAfterMs ?? (line as any).waitAfter?.durationMs ?? 0)),
      waitBeforeName: line.waitBeforeName ?? (line as any).waitBefore?.name ?? '',
      waitAfterName: line.waitAfterName ?? (line as any).waitAfter?.name ?? '',
      endPoint: transformPathPoint(line.endPoint),
      controlPoints: line.controlPoints?.map((cp) => transformPpCoordinate(cp)),
    }));
  }

  function deriveSequence(data: any, normalizedLines: PathLine[]): SequenceItem[] {
    if (Array.isArray(data?.sequence) && data.sequence.length) {
      return data.sequence as SequenceItem[];
    }
    return normalizedLines.map((ln) => ({ kind: 'path', lineId: ln.id! }));
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // clear the LAST import's line first. It was only ever set, never cleared, so a
    // failed import's red line sat under the section for the rest of the session.
    setNotice(null);
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.pp')) {
      setImportNotice('Pick a .pp file.', 'error');
      event.target.value = '';
      return;
    }
    if (settings.savedAutos.length >= MAX_SAVED_AUTOS) {
      setImportNotice(`You can save up to ${MAX_SAVED_AUTOS} autos. Delete one first.`, 'warning');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        if (!data.startPoint || !data.lines) {
          throw new Error('Invalid file format: missing required fields (startPoint or lines)');
        }
        const transformedStartPoint = transformPathPoint(data.startPoint);
        const normalizedLines = normalizeLines(data.lines || []);
        const autoPathData: AutoPathData = {
          fileName: file.name,
          startPoint: transformedStartPoint,
          lines: normalizedLines,
          sequence: deriveSequence(data, normalizedLines),
          version: data.version,
          timestamp: data.timestamp,
        };
        // add to the library AND select it as the active auto
        set({
          savedAutos: [...settings.savedAutos, autoPathData],
          autoPath: autoPathData,
          autoPathEnabled: true,
        });
        setImportNotice(`Saved ${file.name}.`, 'success');
      } catch (error) {
        const errMsg = getErrorMessage(error);
        const message = errMsg.includes('Invalid file format')
          ? 'That isn’t a Pedro Pathing file.'
          : `Couldn’t read that file. ${errMsg}`;
        setImportNotice(message, 'error');
      } finally {
        event.target.value = '';
      }
    };
    reader.onerror = () => {
      setImportNotice('Couldn’t read that file.', 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  // select a saved auto as the active one (a copy stays in the library)
  const selectAuto = (a: AutoPathData) => set({ autoPath: a, autoPathEnabled: true });
  const deleteAuto = (i: number) => {
    const removed = settings.savedAutos[i];
    const savedAutos = settings.savedAutos.filter((_, j) => j !== i);
    const wasActive = !!removed && settings.autoPath?.fileName === removed.fileName;
    set(wasActive ? { savedAutos, autoPath: null, autoPathEnabled: false } : { savedAutos });
  };

  const setAlliance = (alliance: Alliance) => set({ alliance });
  // the start-position editor is built on DECODE's G304 legality + goal geometry —
  // hidden for the Chain Reaction shell (its start rules arrive with its manual).
  const isDecode = settings.game === 'decode';
  // a game that brings its own start editor supplies it through the module slot;
  // absent ⇒ the two inline branches below (DECODE's and CR's), unchanged
  const StartEd = moduleFor(settings.game).startEditor;
  // the saved-pose cap a game's own editor is handed (it cannot read the ads context itself)
  const maxSaved = savedStartCap(useAds().supporter);
  // an auto path only DOES something in a game whose step drives path traversal
  // (`autoPaths`, today DECODE alone). The section used to be shown for every game, so a
  // CR/BIOBUZZ player could import a `.pp`, see "Auto path ON", and then watch their robot
  // do nothing for the whole autonomous period. `coerceSetup` drops the path at spawn.
  const runsAutoPaths = moduleFor(settings.game).autoPaths;
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

        {moduleFor(settings.game).zenithAutos && <AutonomousSetup settings={settings} />}

        {runsAutoPaths && (
        <section className="ds-sec">
          <h2>
            Auto path{' '}
            <span className="ds-count">
              {settings.savedAutos.length}/{MAX_SAVED_AUTOS}
            </span>
          </h2>
          <div className="ds-opts">
            {settings.savedAutos.map((a, i) => {
              const active = settings.autoPath?.fileName === a.fileName;
              return (
                // the card and its ✕ are SIBLINGS in a slot — a button nested inside a
                // button-role card had no clean name and leaked its keypresses to the card
                <div key={i} className="ds-opt-slot">
                  <button
                    className={`ds-opt ${active ? 'on' : ''}`}
                    aria-pressed={active}
                    onClick={() => selectAuto(a)}
                  >
                    <span className="ot">{a.fileName}</span>
                    <span className="od">
                      {a.lines?.length ?? 0} segments
                    </span>
                  </button>
                  <button
                    className="ds-opt-del"
                    title="Delete this auto"
                    aria-label={`Delete ${a.fileName}`}
                    onClick={() => deleteAuto(i)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {settings.savedAutos.length < MAX_SAVED_AUTOS && (
              <label className="ds-opt ds-opt-add">
                <span className="ot">Import a .pp file</span>
                <input type="file" accept=".pp" onChange={handleFileChange} style={{ display: 'none' }} />
              </label>
            )}
          </div>
          {/* THE FILENAME IS THE LABEL. The row used to read "Auto path ON" with the name
              underneath, so the tile said what its own fill already said and the one thing
              the off state cannot otherwise tell you was demoted to a sub-line. */}
          {settings.autoPath && (
            <ToggleRow
              label={`Run ${settings.autoPath.fileName}`}
              value={settings.autoPathEnabled}
              onPick={(autoPathEnabled) => set({ autoPathEnabled })}
            />
          )}
          {notice && (
            <p className={notice.bad ? 'ds-form-err' : 'ds-hint'} role="status">
              {notice.text}
            </p>
          )}
          <p className="ds-hint">
            Build a <code>.pp</code> path at{' '}
            <a href="https://visualizer.pedropathing.com" target="_blank" rel="noreferrer">
              visualizer.pedropathing.com
            </a>
            .
          </p>
        </section>
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
