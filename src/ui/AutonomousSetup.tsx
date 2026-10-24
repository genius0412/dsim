import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { GameSettings } from '../types';
import { moduleFor } from '../games';
import {
  AUTO_LIBRARY_MAX,
  LIBRARY_FULL,
  autoTooLarge,
  importAutos,
  libraryFullFor,
  loadAutoLibrary,
  removeAuto,
  restoreAuto,
  saveAutoLibrary,
  upsertAuto,
  type AutoLibraryEntry,
  type GameAutoLibrary,
  type RemovedAuto,
} from '../auto/library';
import { countOf, endsAtOnce, neverReadsTrue, planVerdict, warningsFact } from './autoHud';
import { ToggleRow } from './OptRow';

type AutoModule = typeof import('./zenithEditor');

/** the notice while Zenith's window is open; its `onClosed` clears exactly this line */
const ZENITH_OPEN_NOTICE = 'Zenith is open in another window. Save there to bring the auto back here.';

/** the line under the library: what happened, and the one thing that can be taken back */
interface Notice {
  bad: boolean;
  text: string;
  undo?: () => void;
}

/** the last "Drive it here" for one auto: its words, and the path the robot drove */
interface Run {
  id: string;
  bad: boolean;
  text: string;
  points?: { x: number; y: number }[];
}

/**
 * THE AUTONOMOUS SECTION of Solo setup (docs/area/autos.md): the player's Zenith autos
 * for this game, a preview of the selected one planned for their alliance and build, and the
 * switch that makes AUTO play it. Shown only for a game that plays Zenith autos
 * (`GameSimModule.zenithAutos`), which is BIOBUZZ.
 *
 * An auto is EDITED IN ZENITH, not here: "Edit in Zenith" opens Zenith's editor with this build's
 * robot file (`zenith-host/1`, `zenithHost.ts`), and its Save lands back in this library. A file
 * from the team's robot repository is imported as it is, with its waypoints file beside it.
 *
 * The Zenith code (schema, planner, follower) is the lazy `autos` chunk, loaded when this
 * section mounts; the library itself is plain `localStorage` (`src/auto/library.ts`).
 *
 * ⚠️ THE ORDER IS THE REACH. This section lives in Play's right column, which scrolls inside itself
 * (docs/area/ui.md THE MENU STAGE), and at 1280x720 that column is ~450px tall. The preview alone is
 * 300px, so with the preview first the buttons were a screen and a half down, under the column's
 * fade and the pinned Solo / Multiplayer bar (Zenith UX sweep W4-D8). So: the library (a compact list
 * that scrolls inside itself past a few rows), Import and New, then the selected auto's verdict,
 * buttons and switch together, then the preview and its facts. The notice sits right under the
 * library, where the delete and the import it answers are; a "Drive it here" result sits under the
 * buttons and the preview it describes.
 */
export function AutonomousSetup({ settings }: { settings: GameSettings }) {
  const game = settings.game;
  const Preview = moduleFor(game).autoPreview;
  const [lib, setLib] = useState<GameAutoLibrary>(() => loadAutoLibrary(game));
  /** the library as of this render, for handlers that run later (an Undo, an import's awaits) */
  const libRef = useRef(lib);
  libRef.current = lib;
  /** the build as of this render: Zenith reads it at every `ready` and every Simulate in DSIM */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [mod, setMod] = useState<AutoModule | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => lib.activeId ?? lib.entries[0]?.id ?? null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** the autos the open Zenith session was not given, and why (`onLeftOut`) */
  const [leftOut, setLeftOut] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  /** the command list is open for a player with no autos yet, who is the one who needs it */
  const empty = lib.entries.length === 0;
  const [cmdsOpen, setCmdsOpen] = useState(empty);
  const listRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  /** a delete from the keyboard moves focus to Undo: the row it was on is gone */
  const focusUndo = useRef(false);

  useEffect(() => {
    let cancelled = false;
    import('./zenithEditor').then(
      (m) => !cancelled && setMod(m),
      (err) => {
        // eslint-disable-next-line no-console
        console.warn('[autos] the Zenith chunk failed to load', err);
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // another tab (or Zenith's Save while this screen is open) may have written the library
  useEffect(() => setLib(loadAutoLibrary(game)), [game]);
  // ...and so may a Zenith Save that landed while this screen was not the one that opened Zenith
  // (left and came back while the popup was open: the save updates storage, and its callback
  // goes to the screen that is gone). Reload on the way back from the popup, so the toggle below
  // never commits a stale library over the auto Zenith just saved.
  useEffect(() => {
    const reload = (): void => setLib(loadAutoLibrary(game));
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [game]);
  // deleting the last auto brings the command list back, as it was for a first visit
  useEffect(() => {
    if (empty) setCmdsOpen(true);
  }, [empty]);

  /** Saves and shows `next`. False when the browser refused the write, with the reason already in the notice. */
  const commit = (next: GameAutoLibrary): boolean => {
    setLib(next);
    libRef.current = next;
    if (saveAutoLibrary(game, next)) return true;
    setNotice({ bad: true, text: 'Couldn’t save the auto library on this device. Free some browser storage and try again.' });
    return false;
  };

  const selected: AutoLibraryEntry | null = lib.entries.find((e) => e.id === selectedId) ?? lib.entries[0] ?? null;
  const adapter = mod?.autoAdapterFor(game) ?? null;

  // the selected row stays in view of the list that scrolls inside itself: an import or an Undo
  // can select a row above or below what it shows
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.ds-opt.on')?.parentElement;
    if (!list || !row) return;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [selected?.id, lib.entries.length]);

  useEffect(() => {
    if (focusUndo.current && notice?.undo) undoRef.current?.focus();
    focusUndo.current = false;
  }, [notice]);

  // the selected auto, planned for THIS alliance and build
  const view = useMemo(() => {
    if (!mod || !adapter || !selected) return null;
    try {
      const loaded = mod.loadZenithAuto(selected, settings.alliance, settings.spec, adapter);
      // `AutoView.unsupported` joins commands and conditions, which fail differently: a command
      // ends at once, a condition never reads true. The panel says which.
      const used = mod.namesUsed(loaded.written);
      return {
        ok: true as const,
        v: mod.autoView(loaded),
        commands: used.commands.filter((n) => !adapter.commands.includes(n)),
        conditions: used.conditions.filter((n) => !adapter.conditions.includes(n)),
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [mod, adapter, selected, settings.alliance, settings.spec]);

  const full = lib.entries.length >= AUTO_LIBRARY_MAX;
  const running = lib.enabled && !!selected && lib.activeId === selected.id;

  // THE COMMANDS AN AUTO CAN USE on this build: read off the same robot file Zenith is handed, so
  // the list here and Zenith's insert menu can never disagree
  const registry = useMemo(() => {
    if (!adapter) return null;
    const r = adapter.robot(settings.spec) as {
      commands?: { name: string; summary?: string }[];
      conditions?: { name: string; summary?: string }[];
    };
    return { commands: r.commands ?? [], conditions: r.conditions ?? [] };
  }, [adapter, settings.spec]);

  async function importFiles(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!mod || files.length === 0) return;
    const texts = await Promise.all(files.map(async (f) => ({ file: f.name, text: await f.text() })));
    // a waypoints.json among them rides with every auto imported beside it
    let waypoints: string | undefined;
    const autos: { file: string; text: string }[] = [];
    for (const t of texts) {
      try {
        const j = JSON.parse(t.text) as Record<string, unknown>;
        if (j && typeof j === 'object' && 'waypoints' in j && !('steps' in j)) waypoints = t.text;
        else autos.push(t);
      } catch {
        autos.push(t); // parseAutoText says what is wrong with it
      }
    }
    // parse every file first: a NEW name into a full library is refused below (`importAutos`),
    // not dropped by `upsertAuto`'s cap in silence, which could take the auto AUTO plays
    const parsed: { file: string; name: string; auto: string; waypoints?: string }[] = [];
    const failed: string[] = [];
    for (const a of autos) {
      try {
        const auto = mod.parseAutoText(a.text);
        const tooLarge = autoTooLarge(a.text);
        if (tooLarge) throw new Error(tooLarge);
        parsed.push({ file: a.file, name: auto.name, auto: a.text, ...(waypoints ? { waypoints } : {}) });
      } catch (err) {
        failed.push(`Couldn’t import ${a.file}. ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // the library as it is NOW: the reads above awaited, and a Save may have landed meanwhile
    const { lib: next, added, refused } = importAutos(libRef.current, parsed);
    if (autos.length === 0 && waypoints && selected) {
      // a waypoints file on its own: give it to the selected auto
      if (commit(upsertAuto(libRef.current, { ...selected, waypoints, savedAt: Date.now() }))) {
        setNotice({ bad: false, text: `Added the waypoints to ${selected.name}.` });
      }
      return;
    }
    const said = [
      added.length === 0 ? '' : added.length === 1 ? `Imported ${added[0]}.` : `Imported ${countOf(added.length, 'auto')}.`,
      refused.length === 0 ? '' : libraryFullFor(refused),
      ...failed,
    ].filter(Boolean);
    if (added.length > 0) {
      if (!commit(next)) return;
      setSelectedId(next.entries.find((x) => x.name === added[added.length - 1])?.id ?? null);
    }
    if (said.length > 0) setNotice({ bad: refused.length + failed.length > 0, text: said.join(' ') });
  }

  /**
   * DELETE, WITH AN UNDO (Zenith UX sweep W4-D10): it was instant and permanent. The notice that
   * follows carries a button that puts the entry back where it was and, when it was the auto AUTO
   * plays, makes it that again. One level: the next notice replaces it.
   */
  function remove(entry: AutoLibraryEntry, byKeyboard: boolean): void {
    const out = removeAuto(lib, entry.id);
    if (!out) return;
    if (!commit(out.lib)) return;
    if (selectedId === entry.id) setSelectedId(out.lib.entries[0]?.id ?? null);
    setRun(null);
    focusUndo.current = byKeyboard;
    setNotice({ bad: false, text: `Deleted ${entry.name}.`, undo: () => restore(out.removed) });
  }

  function restore(removed: RemovedAuto): void {
    const back = restoreAuto(libRef.current, removed);
    if (!back.ok) {
      setNotice({ bad: true, text: back.error });
      return;
    }
    if (!commit(back.lib)) return;
    setSelectedId(removed.entry.id);
    setNotice({ bad: false, text: `Restored ${removed.entry.name}.` });
  }

  function setRunning(on: boolean): void {
    if (!selected) return;
    commit({ ...lib, activeId: selected.id, enabled: on });
  }

  function editInZenith(entry: AutoLibraryEntry | null): void {
    if (!mod) return;
    const error = mod.launchZenith({
      settings,
      liveSettings: () => settingsRef.current,
      open: entry?.name ?? null,
      onLibrary: (next, name) => {
        setLib(next);
        setSelectedId(next.entries.find((e) => e.name === name)?.id ?? null);
        setNotice({ bad: false, text: `Saved ${name} from Zenith.` });
      },
      onLeftOut: setLeftOut,
      // the popup closed: drop the "open in another window" line and the session's left-out
      // sentence, but keep a notice something else has put there since (a save, an import)
      onClosed: () => {
        setNotice((n) => (n?.text === ZENITH_OPEN_NOTICE || n?.text === mod.ZENITH_NOT_READY ? null : n));
        setLeftOut(null);
      },
      // Zenith has not said `ready` (usually its sign-in page), then has: swap the open line for
      // the wait sentence and back, leaving any other notice alone
      onWaiting: (sentence) =>
        setNotice((n) =>
          sentence !== null
            ? n?.text === ZENITH_OPEN_NOTICE
              ? { bad: false, text: sentence }
              : n
            : n?.text === mod.ZENITH_NOT_READY
              ? { bad: false, text: ZENITH_OPEN_NOTICE }
              : n,
        ),
    });
    if (error) setLeftOut(null);
    setNotice(error ? { bad: true, text: error } : { bad: false, text: ZENITH_OPEN_NOTICE });
  }

  /** run the selected auto headless and draw what the robot really drove over the plan */
  function tryHere(): void {
    if (!mod || !selected) return;
    try {
      const r = mod.runAutoHeadless({
        game,
        spec: settings.spec,
        setup: selected,
        alliance: settings.alliance,
        physics: '2d',
      });
      setRun({
        id: selected.id,
        bad: r.state !== 'done',
        points: r.trace.poses.map(([, x, y]) => ({ x, y })),
        text:
          r.state === 'done'
            ? `Driven in ${r.trace.simTimeS.toFixed(1)} s. The dashed line is where the robot went.`
            : 'The auto was still running when AUTO ended. The dashed line is how far it got.',
      });
    } catch (err) {
      setRun({ id: selected.id, bad: true, text: `Couldn’t run it. ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const v = view?.ok ? view.v : null;
  const status = !selected ? null : !view ? { ok: true, text: 'Planning…' } : !view.ok ? { ok: false, text: view.error } : v ? planVerdict(v) : null;
  const thisRun = run && selected && run.id === selected.id ? run : null;
  const warnings = v ? warningsFact(v.warnings) : null;

  return (
    <section className="ds-sec">
      <h2>
        Autonomous{' '}
        <span className="ds-count">
          {lib.entries.length}/{AUTO_LIBRARY_MAX}
        </span>
      </h2>
      {loadFailed && <p className="ds-form-err">Couldn’t load the autonomous tools. Reload the page to try again.</p>}
      {lib.entries.length > 0 && (
        <div className="ds-opts list" role="group" aria-label="Autos" ref={listRef}>
          {lib.entries.map((e) => {
            const on = selected?.id === e.id;
            return (
              <div key={e.id} className="ds-opt-slot">
                <button
                  className={`ds-opt ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  title={e.name}
                  onClick={() => {
                    setSelectedId(e.id);
                    setRun(null);
                  }}
                >
                  <span className="ot">{e.name}</span>
                  <span className="od">{lib.enabled && lib.activeId === e.id ? 'Plays in AUTO' : e.source === 'zenith' ? 'From Zenith' : 'Imported'}</span>
                </button>
                <button
                  className="ds-opt-del"
                  title="Delete this auto"
                  aria-label={`Delete ${e.name}`}
                  onClick={(ev) => remove(e, ev.detail === 0)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="ds-opts two">
        {/* Import stays on at 12: a file named like an auto in the library REPLACES it, and a new
            name is refused with a sentence that names the file. New in Zenith makes a new name
            every time, so it is the one that goes off (disabled, not gone, with the reason below). */}
        <label className="ds-opt mini ds-opt-add">
          <span className="ot">Import .auto.json</span>
          <input type="file" accept=".json,application/json" multiple disabled={!mod} onChange={importFiles} hidden />
        </label>
        <button
          className="ds-opt mini ds-opt-add"
          disabled={!mod || full}
          title={full ? LIBRARY_FULL : undefined}
          onClick={() => editInZenith(null)}
        >
          <span className="ot">New in Zenith</span>
        </button>
      </div>
      {full && <p className="ds-hint">{LIBRARY_FULL}</p>}
      {notice && (
        <div className="ds-auto-note">
          <p className={notice.bad ? 'ds-form-err' : 'ds-hint'} role="status">
            {notice.text}
          </p>
          {notice.undo && (
            <button type="button" className="ds-btn ghost small" ref={undoRef} onClick={notice.undo}>
              Undo
            </button>
          )}
        </div>
      )}
      {leftOut && <p className="ds-hint">{leftOut}</p>}

      {selected && (
        <div className="ds-auto-side">
          <div className={`ds-auto-status ${status?.ok ? 'ok' : 'bad'}`} role="status">
            {status?.text}
          </div>
          <div className="ds-auto-tools">
            <button type="button" className="ds-btn small" disabled={!mod} onClick={() => editInZenith(selected)}>
              Edit in Zenith
            </button>
            <button type="button" className="ds-btn ghost small" disabled={!v} onClick={tryHere}>
              Drive it here
            </button>
          </div>
          <ToggleRow label="Play it in AUTO" value={running} onPick={setRunning} />
          {thisRun && (
            <p className={thisRun.bad ? 'ds-form-err' : 'ds-hint'} role="status">
              {thisRun.text}
            </p>
          )}
        </div>
      )}

      {/* just under the buttons, so it is found: it was a closed fold below everything (DSIM-8),
          and open for a player with no autos, who has nothing else on this panel to read */}
      {registry && (
        <details className="ds-auto-cmds" open={cmdsOpen} onToggle={(e) => setCmdsOpen(e.currentTarget.open)}>
          <summary>Commands your auto can use</summary>
          <dl>
            {registry.commands.map((c) => (
              <div key={c.name}>
                <dt>
                  <code>{c.name}</code>
                </dt>
                <dd>{c.summary}</dd>
              </div>
            ))}
            {registry.conditions.map((c) => (
              <div key={c.name}>
                <dt>
                  <code>{c.name}</code>
                </dt>
                <dd>{c.summary} For waits, branches and ending a path early.</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {selected && (
        <div className="ds-auto-view">
          <div className="ds-auto-stage">
            {Preview && v ? (
              <Preview
                spec={settings.spec}
                alliance={settings.alliance}
                legs={v.legs}
                poses={v.poses}
                driven={thisRun?.points}
              />
            ) : (
              <div className="ds-auto-blank ds-loading">{view && !view.ok ? 'No preview' : 'Loading…'}</div>
            )}
          </div>
          {v && (
            <dl className="ds-facts">
              <dt>Written for</dt>
              <dd>{v.fileAlliance}{v.mirrored ? `, mirrored for ${settings.alliance.toUpperCase()}` : ''}</dd>
              {warnings && (
                <>
                  <dt>{warnings.label}</dt>
                  <dd>{warnings.text}</dd>
                </>
              )}
              {view?.ok && view.commands.length > 0 && (
                <>
                  <dt>Not in DSIM</dt>
                  <dd>{view.commands.join(', ')}. {endsAtOnce(view.commands)}</dd>
                </>
              )}
              {view?.ok && view.conditions.length > 0 && (
                <>
                  <dt>Conditions not in DSIM</dt>
                  <dd>{view.conditions.join(', ')}. {neverReadsTrue(view.conditions)}</dd>
                </>
              )}
              {v.notOnRobot.length > 0 && (
                <>
                  <dt>Not on this robot</dt>
                  <dd>{v.notOnRobot.map((c) => `${c.name}: ${c.why}`).join(' ')} {endsAtOnce(v.notOnRobot.map((c) => c.name))}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}

      <p className="ds-hint">
        In a match, solo or in a custom room, the robot starts where the auto does and drives it through AUTO. Ranked
        matches never run one. In Free drive the auto plays once, and RESET plays it again. An auto that names
        waypoints imports with its waypoints.json: pick both files together.
      </p>
    </section>
  );
}
