import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { GameSettings } from '../types';
import { moduleFor } from '../games';
import {
  AUTO_LIBRARY_MAX,
  loadAutoLibrary,
  saveAutoLibrary,
  upsertAuto,
  type AutoLibraryEntry,
  type GameAutoLibrary,
} from '../auto/library';
import { ToggleRow } from './OptRow';

type AutoModule = typeof import('./zenithEditor');

/**
 * THE AUTONOMOUS SECTION of Configure ▸ Match (docs/area/autos.md): the player's Zenith autos
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
 */
export function AutonomousSetup({ settings }: { settings: GameSettings }) {
  const game = settings.game;
  const Preview = moduleFor(game).autoPreview;
  const [lib, setLib] = useState<GameAutoLibrary>(() => loadAutoLibrary(game));
  const [mod, setMod] = useState<AutoModule | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => lib.activeId ?? lib.entries[0]?.id ?? null);
  const [notice, setNotice] = useState<{ bad: boolean; text: string } | null>(null);
  const [driven, setDriven] = useState<{ id: string; points: { x: number; y: number }[] } | null>(null);

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

  const commit = (next: GameAutoLibrary): void => {
    setLib(next);
    if (!saveAutoLibrary(game, next)) {
      setNotice({ bad: true, text: 'Couldn’t save the auto library on this device. Free some browser storage and try again.' });
    }
  };

  const selected: AutoLibraryEntry | null = lib.entries.find((e) => e.id === selectedId) ?? lib.entries[0] ?? null;
  const adapter = mod?.autoAdapterFor(game) ?? null;

  // the selected auto, planned for THIS alliance and build
  const view = useMemo(() => {
    if (!mod || !adapter || !selected) return null;
    try {
      const loaded = mod.loadZenithAuto(selected, settings.alliance, settings.spec, adapter);
      return { ok: true as const, v: mod.autoView(loaded) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [mod, adapter, selected, settings.alliance, settings.spec]);

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
    let next = lib;
    const added: string[] = [];
    for (const a of autos) {
      try {
        const auto = mod.parseAutoText(a.text);
        next = upsertAuto(next, {
          name: auto.name,
          auto: a.text,
          ...(waypoints ? { waypoints } : {}),
          source: 'file',
          savedAt: Date.now(),
        });
        added.push(auto.name);
      } catch (err) {
        setNotice({ bad: true, text: `Couldn’t import ${a.file}. ${err instanceof Error ? err.message : String(err)}` });
        if (added.length === 0 && next === lib) return;
      }
    }
    if (added.length === 0 && waypoints && selected) {
      // a waypoints file on its own: give it to the selected auto
      next = upsertAuto(next, { ...selected, waypoints, savedAt: Date.now() });
      commit(next);
      setNotice({ bad: false, text: `Added the waypoints to ${selected.name}.` });
      return;
    }
    if (added.length === 0) return;
    commit(next);
    setSelectedId(next.entries.find((x) => x.name === added[added.length - 1])?.id ?? null);
    setNotice({ bad: false, text: added.length === 1 ? `Imported ${added[0]}.` : `Imported ${added.length} autos.` });
  }

  function remove(entry: AutoLibraryEntry): void {
    const entries = lib.entries.filter((e) => e.id !== entry.id);
    const activeId = lib.activeId === entry.id ? null : lib.activeId;
    commit({ entries, activeId, enabled: lib.enabled && activeId !== null });
    if (selectedId === entry.id) setSelectedId(entries[0]?.id ?? null);
    setDriven(null);
  }

  function setRunning(on: boolean): void {
    if (!selected) return;
    commit({ ...lib, activeId: selected.id, enabled: on });
  }

  function editInZenith(entry: AutoLibraryEntry | null): void {
    if (!mod) return;
    const error = mod.launchZenith({
      settings,
      open: entry?.name ?? null,
      onLibrary: (next, name) => {
        setLib(next);
        setSelectedId(next.entries.find((e) => e.name === name)?.id ?? null);
        setNotice({ bad: false, text: `Saved ${name} from Zenith.` });
      },
    });
    setNotice(error ? { bad: true, text: error } : { bad: false, text: 'Zenith is open in another window. Save there to bring the auto back here.' });
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
      setDriven({ id: selected.id, points: r.trace.poses.map(([, x, y]) => ({ x, y })) });
      setNotice({
        bad: r.state !== 'done',
        text:
          r.state === 'done'
            ? `Driven in ${r.trace.simTimeS.toFixed(1)} s. The dashed line is where the robot went.`
            : 'The auto was still running when AUTO ended. The dashed line is how far it got.',
      });
    } catch (err) {
      setNotice({ bad: true, text: `Couldn’t run it. ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const v = view?.ok ? view.v : null;
  const status = !selected
    ? null
    : !view
      ? { ok: true, text: 'Planning…' }
      : !view.ok
        ? { ok: false, text: view.error }
        : v && v.errors.length > 0
          ? { ok: false, text: `${v.errors.length} ${v.errors.length === 1 ? 'problem' : 'problems'}: ${v.errors[0].message}` }
          : {
              ok: true,
              text: `${v?.steps ?? 0} steps, ${v?.atLeast ? 'at least ' : 'about '}${(v?.estimateS ?? 0).toFixed(1)} s of ${v?.periodS ?? 30} s`,
            };

  return (
    <section className="ds-sec">
      <h2>
        Autonomous{' '}
        <span className="ds-count">
          {lib.entries.length}/{AUTO_LIBRARY_MAX}
        </span>
      </h2>
      {loadFailed && <p className="ds-form-err">Couldn’t load the autonomous tools. Reload the page to try again.</p>}
      <div className="ds-opts">
        {lib.entries.map((e) => {
          const on = selected?.id === e.id;
          return (
            <div key={e.id} className="ds-opt-slot">
              <button
                className={`ds-opt ${on ? 'on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  setSelectedId(e.id);
                  setDriven(null);
                }}
              >
                <span className="ot">{e.name}</span>
                <span className="od">{lib.enabled && lib.activeId === e.id ? 'Plays in AUTO' : e.source === 'zenith' ? 'From Zenith' : 'Imported'}</span>
              </button>
              <button className="ds-opt-del" title="Delete this auto" aria-label={`Delete ${e.name}`} onClick={() => remove(e)}>
                ✕
              </button>
            </div>
          );
        })}
        {lib.entries.length < AUTO_LIBRARY_MAX && (
          <>
            <label className="ds-opt ds-opt-add">
              <span className="ot">Import .auto.json</span>
              <span className="od">With its waypoints.json</span>
              <input type="file" accept=".json,application/json" multiple disabled={!mod} onChange={importFiles} hidden />
            </label>
            <button className="ds-opt ds-opt-add" disabled={!mod} onClick={() => editInZenith(null)}>
              <span className="ot">New in Zenith</span>
              <span className="od">Opens the editor</span>
            </button>
          </>
        )}
      </div>

      {selected && (
        <div className="ds-auto">
          <div className="ds-auto-stage">
            {Preview && v ? (
              <Preview
                spec={settings.spec}
                alliance={settings.alliance}
                legs={v.legs}
                poses={v.poses}
                driven={driven && driven.id === selected.id ? driven.points : undefined}
              />
            ) : (
              <div className="ds-auto-blank ds-loading">{view && !view.ok ? 'No preview' : 'Loading…'}</div>
            )}
          </div>
          <div className="ds-auto-side">
            <div className={`ds-auto-status ${status?.ok ? 'ok' : 'bad'}`} role="status">
              {status?.text}
            </div>
            {v && (
              <dl className="ds-auto-facts">
                <dt>Written for</dt>
                <dd>{v.fileAlliance}{v.mirrored ? `, mirrored for ${settings.alliance.toUpperCase()}` : ''}</dd>
                {v.warnings.length > 0 && (
                  <>
                    <dt>Warnings</dt>
                    <dd>{v.warnings.length}: {v.warnings[0].message}</dd>
                  </>
                )}
                {v.unsupported.length > 0 && (
                  <>
                    <dt>Not in DSIM</dt>
                    <dd>{v.unsupported.join(', ')}. These end at once.</dd>
                  </>
                )}
              </dl>
            )}
            <div className="ds-auto-tools">
              <button type="button" className="ds-btn small" disabled={!mod} onClick={() => editInZenith(selected)}>
                Edit in Zenith
              </button>
              <button type="button" className="ds-btn ghost small" disabled={!v} onClick={tryHere}>
                Drive it here
              </button>
            </div>
            <ToggleRow label="Play it in AUTO" value={running} onPick={setRunning} />
          </div>
        </div>
      )}

      {registry && (
        <details className="ds-auto-cmds">
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

      {notice && (
        <p className={notice.bad ? 'ds-form-err' : 'ds-hint'} role="status">
          {notice.text}
        </p>
      )}
      <p className="ds-hint">
        In a match, solo or in a custom room, the robot starts where the auto does and drives it through AUTO. Ranked
        matches never run one. In Free drive the auto plays once, and Restart plays it again.
      </p>
    </section>
  );
}
